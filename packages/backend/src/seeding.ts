import { localIdentities } from "./identity";
import { addInventory } from "./inventory";
import { authorizeAdministrator } from "./authorization";
import { transact } from "./repository";

export async function seedDatabase(
  binding: D1Database,
  now = new Date().toISOString(),
) {
  return transact(binding, (state) => {
    for (const user of localIdentities)
      if (!state.users.some((entry) => entry.id === user.id))
        state.users.push(user);
    return addInventory(state, "seed-v1", now);
  });
}

export async function restockInventory(
  binding: D1Database,
  userId: string,
  operationId: string,
  now = new Date().toISOString(),
) {
  return transact(binding, (state) => {
    authorizeAdministrator(state, userId);
    return addInventory(state, `stock-${operationId}`, now);
  });
}
