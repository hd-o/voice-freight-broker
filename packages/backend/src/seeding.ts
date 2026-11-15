import { localIdentities } from "./identity";
import { addInventory } from "./inventory";
import { authorizeAdministrator } from "./authorization";
import { transact } from "./repository";

export async function seedDatabase(
  binding: D1Database,
  now = new Date().toISOString(),
): Promise<ReturnType<typeof addInventory>> {
  return transact(binding, (state): ReturnType<typeof addInventory> => {
    for (const user of localIdentities) {
      if (!state.users.some((entry): boolean => entry.id === user.id)) {
        state.users.push(user);
      }
    }

    return addInventory(state, "seed-v1", now);
  });
}

export async function restockInventory(
  binding: D1Database,
  userId: string,
  operationId: string,
  now = new Date().toISOString(),
): Promise<ReturnType<typeof addInventory>> {
  return transact(binding, (state): ReturnType<typeof addInventory> => {
    authorizeAdministrator(state, userId);

    return addInventory(state, `stock-${operationId}`, now);
  });
}
