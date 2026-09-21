import { connectViaWebSocket } from './packages/client/src/websocket.ts';

const accessor = await connectViaWebSocket('ws://127.0.0.1:3030/ws');
console.log('已连接');
const view: any = await Promise.race([
  accessor.modelSelectionService.getView(),
  new Promise((_, r) => setTimeout(() => r(new Error('timeout 15s')), 15000)),
]);
console.log('providers:', view?.providers?.length ?? 0);
console.log('names:', JSON.stringify((view?.providers || []).map((p: any) => p.name || p.id).slice(0, 6)));
console.log('selectedModel:', JSON.stringify(view?.selectedModel ?? null));
process.exit(0);
