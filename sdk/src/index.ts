// @isub/sdk — typed client for the iSub recurring/metered pull-payment primitive on Sui (gRPC).

export * from './constants';
export * from './types';
export * from './errors';
export * from './signer';
export * from './wallet-signer';
export { IsubClient } from './client';
export * from './keeper';
export * from './store';
export * from './reconcile';
export * from './exposure';
export * from './lag';
export * from './pricing';
export * from './consent';
export * from './agent-auth';
export * from './scheduler';
export * from './compliance';
// Role-surface subpaths — import directly, not via the core index:
//   `@isub/sdk/agent`       — IsubAgent + MCP/LangChain tool descriptors (agent/payer runtime; dep-free)
//   `@isub/sdk/biller`      — IsubBiller PAYG metering→settle pipeline + memBillerStore (service/payee; dep-free)
//   `@isub/sdk/webhook`     — signed webhook delivery + verifyWebhook (Node: node:crypto)
//   `@isub/sdk/store-file`  — durable file-backed KeeperStore (Node: node:fs)
//   `@isub/sdk/db`, `@isub/sdk/sql-store` — multi-tenant SQL persistence (Node: node:sqlite)
/** Low-level PTB builders, namespaced: `tx.charge(transaction, cfg, …)`, etc. */
export * as tx from './tx';
