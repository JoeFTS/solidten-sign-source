import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { buildWebhookSignatureHeaders } from './webhook-signature';

const N8N_DIR = path.resolve(__dirname, '../../../../docs/sign-integrations/n8n');

type TN8nNode = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
};

type TN8nWorkflow = {
  name: string;
  nodes: TN8nNode[];
  connections: Record<string, { main: { node: string; type: string; index: number }[][] }>;
};

const KNOWN_NODE_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.code',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.set',
  'n8n-nodes-base.httpRequest',
]);

const loadWorkflow = (file: string): TN8nWorkflow => JSON.parse(fs.readFileSync(path.join(N8N_DIR, file), 'utf8'));

describe.each(['document-completed-webhook.json', 'create-and-send-from-template.json'])('n8n workflow %s', (file) => {
  const workflow = loadWorkflow(file);

  it('has well-formed nodes with unique names and ids', () => {
    expect(workflow.name).toMatch(/Solid Ten Sign/);
    expect(workflow.nodes.length).toBeGreaterThanOrEqual(2);

    expect(new Set(workflow.nodes.map((n) => n.name)).size).toBe(workflow.nodes.length);
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(workflow.nodes.length);

    for (const node of workflow.nodes) {
      expect(KNOWN_NODE_TYPES.has(node.type), node.type).toBe(true);
      expect(typeof node.typeVersion).toBe('number');
      expect(node.position).toHaveLength(2);
      expect(typeof node.parameters).toBe('object');
    }
  });

  it('connects every node into one chain from the trigger', () => {
    const names = new Set(workflow.nodes.map((n) => n.name));
    const reached = new Set<string>();

    for (const [from, outputs] of Object.entries(workflow.connections)) {
      expect(names.has(from), from).toBe(true);

      for (const target of outputs.main.flat()) {
        expect(names.has(target.node), target.node).toBe(true);
        expect(target.type).toBe('main');
        reached.add(target.node);
      }
    }

    const roots = [...names].filter((name) => !reached.has(name));

    expect(roots).toHaveLength(1);
    expect(reached.size).toBe(names.size - 1);
  });

  it('carries no real secret or token', () => {
    const text = JSON.stringify(workflow);

    expect(text).not.toMatch(/api_[a-z0-9]{10,}/i);
    expect(text).not.toMatch(/whsec_/);
  });
});

describe('n8n verify-signature code node', () => {
  const workflow = loadWorkflow('document-completed-webhook.json');
  const code = String(workflow.nodes.find((n) => n.type === 'n8n-nodes-base.code')?.parameters.jsCode);
  const secret = 'REPLACE_WITH_YOUR_WEBHOOK_SECRET';

  // Runs the node's code the way n8n does: a function body with $input and require in scope.
  const runNode = (items: { json: unknown }[]) =>
    vm.runInNewContext(`(() => { ${code} })()`, {
      $input: { all: () => items },
      require: (name: string) => {
        if (name !== 'crypto') {
          throw new Error(`unexpected require ${name}`);
        }

        return { createHmac, timingSafeEqual: (a: Buffer, b: Buffer) => a.equals(b) };
      },
      Buffer,
      Date,
      JSON,
      Math,
      Number,
      String,
      Error,
    }) as { json: { event: string; document: { title: string } } }[];

  const delivery = (event: string, now = new Date()) => {
    const body = { event, payload: { id: 1, title: 'Lease "4" – Łódź' }, createdAt: now.toISOString() };
    const raw = JSON.stringify(body);
    const headers = buildWebhookSignatureHeaders({ secret, body: raw, now });

    return {
      json: {
        headers: {
          'x-solidten-timestamp': headers['X-SolidTen-Timestamp'],
          'x-solidten-signature': headers['X-SolidTen-Signature'],
        },
        // n8n hands the node the parsed body.
        body: JSON.parse(raw),
      },
    };
  };

  it('passes a signed DOCUMENT_COMPLETED delivery through', () => {
    const result = runNode([delivery('DOCUMENT_COMPLETED')]);

    expect(result).toHaveLength(1);
    expect(result[0].json.document.title).toBe('Lease "4" – Łódź');
  });

  it('drops other events and throws on a bad signature or an old delivery', () => {
    expect(runNode([delivery('DOCUMENT_SENT')])).toHaveLength(0);

    const tampered = delivery('DOCUMENT_COMPLETED');
    (tampered.json.body as { payload: { title: string } }).payload.title = 'Changed';

    expect(() => runNode([tampered])).toThrow('Signature does not match');
    expect(() => runNode([delivery('DOCUMENT_COMPLETED', new Date(Date.now() - 10 * 60 * 1000))])).toThrow('too old');
  });
});
