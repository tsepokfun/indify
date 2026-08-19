#!/usr/bin/env node
/** 草稿写回探针:读草稿→改 start 节点标题→写 UTF-8 JSON 供 POST。 */
import { readFileSync, writeFileSync } from 'node:fs';

const inFile = process.argv[2] ?? 'generated/m0/draft-get.json';
const outFile = process.argv[3] ?? 'generated/m0/draft-post.json';
const draft = JSON.parse(readFileSync(inFile, 'utf8'));
const startNode = draft.graph.nodes.find((n) => n.data.type === 'start');
startNode.data.title = 'Start (Indify M0 改)';
const payload = {
  graph: draft.graph,
  features: draft.features,
  hash: draft.hash,
  environment_variables: draft.environment_variables ?? [],
  conversation_variables: draft.conversation_variables ?? [],
};
writeFileSync(outFile, JSON.stringify(payload), 'utf8');
console.log(`written ${outFile} (start title -> ${startNode.data.title})`);
