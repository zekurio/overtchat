import "server-only";
import { listHostConnectors } from "@/lib/db/hostConnectors";
import { hostConnectorBroker } from "./broker";

/**
 * Stops every agent session on the user's Host Connectors, as when they lose
 * administrator access. Connectors that are offline or fail are skipped.
 */
export async function stopUserAgents(userId: string): Promise<void> {
  await Promise.allSettled(
    listHostConnectors(userId).map((connector) =>
      hostConnectorBroker.request(connector.id, { type: "stop_all" }),
    ),
  );
}
