export const PLACE_ORDER_RPC = "place_order_v2";

export async function callPlaceOrderRpc(client, payload) {
  const { data, error } = await client.rpc(PLACE_ORDER_RPC, { p_order: payload });
  if (error) throw error;
  return data;
}
