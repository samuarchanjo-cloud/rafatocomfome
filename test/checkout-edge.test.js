import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Execute the actual handler with isolated Supabase clients, without Deno/network.
const source = readFileSync(new URL('../supabase/functions/delivery-routing/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
function handler({ user, authError, rpcError } = {}) {
  let serve;
  const rpcCalls = [];
  const values = { SUPABASE_URL: 'https://synthetic.test', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' };
  vm.runInNewContext(source, {
    Deno: { env: { get: name => values[name] }, serve: fn => { serve = fn; } }, Response,
    console: { error() {}, warn() {} },
    createClient: (_url, key) => key === 'service' ? {
      rpc: async (name, payload) => { rpcCalls.push({ name, payload }); return { data: { id: 'order' }, error: rpcError }; },
    } : { auth: { getUser: async () => ({ data: { user }, error: authError }) } },
  });
  return { rpcCalls, run: token => serve(new Request('https://synthetic.test', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'place_order', order: { delivery_type: 'retirada', customer_id: 'untrusted' } }),
  })) };
}

test('Edge: visitante usa v4 com ator nulo e não exige signup', async () => {
  const { run, rpcCalls } = handler();
  assert.equal((await run('anon')).status, 200);
  assert.equal(rpcCalls[0].name, 'place_order_v4');
  assert.equal(rpcCalls[0].payload.p_actor_user_id, null);
});

test('Edge: cliente cadastrado é vinculado ao usuário verificado, não ao payload', async () => {
  const { run, rpcCalls } = handler({ user: { id: 'verified' } });
  assert.equal((await run('user-token')).status, 200);
  assert.equal(rpcCalls[0].payload.p_actor_user_id, 'verified');
});

test('Edge: JWT inválido/getUser indisponível não degrada compra para visitante', async () => {
  for (const authError of [new Error('expired'), new Error('network')]) {
    const { run, rpcCalls } = handler({ authError });
    const response = await run('user-token');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'AUTH_REQUIRED');
    assert.equal(rpcCalls.length, 0);
  }
});

test('Edge: erro de RPC continua sendo erro e nunca sucesso de criação', async () => {
  const { run, rpcCalls } = handler({ rpcError: new Error('CUSTOMER_ADDRESS_FORBIDDEN') });
  const response = await run('anon');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'CUSTOMER_ADDRESS_FORBIDDEN');
  assert.equal(rpcCalls.length, 1);
});
