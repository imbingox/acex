import type {
  MarketAdapter,
  PrivateUserDataAdapter,
} from "../adapters/types.ts";
import type {
  VenueAccountCapabilities,
  VenueCapabilities,
  VenueMarketCapabilities,
  VenueOrderCapabilities,
} from "../types/client.ts";
import { SUPPORTED_VENUES, type Venue } from "../types/shared.ts";

const unsupportedAccount: VenueAccountCapabilities = {
  register: "unsupported",
  snapshot: "unsupported",
  updates: "unsupported",
  balances: "unsupported",
  positions: "unsupported",
  risk: "unsupported",
  lending: "unsupported",
  credentialsRequired: false,
};

const unsupportedOrder: Omit<VenueOrderCapabilities, "reason"> = {
  supported: false,
  openOrders: "unsupported",
  updates: "unsupported",
  fees: "unsupported",
  create: "unsupported",
  cancel: "unsupported",
  cancelAll: "unsupported",
  orderTypes: [],
  timeInForce: [],
  postOnly: false,
  reduceOnly: false,
  positionSide: "unsupported",
  clientOrderId: false,
};

const typeOnlyNotes = [
  "Venue is declared in public types but has no runtime adapter yet.",
];

const unsupportedMarket: VenueMarketCapabilities = {
  catalog: "unsupported",
  serverTime: "unsupported",
  l1Book: "unsupported",
  fundingRate: "unsupported",
  marketTypes: [],
};

export interface VenueCapabilityAdapterRegistry {
  marketAdapters: ReadonlyMap<Venue, MarketAdapter>;
  privateAdapters: ReadonlyMap<Venue, PrivateUserDataAdapter>;
}

export function getVenueCapabilitiesSnapshot(
  venue: Venue,
  registry: VenueCapabilityAdapterRegistry,
): VenueCapabilities {
  const marketAdapter = registry.marketAdapters.get(venue);
  const privateAdapter = registry.privateAdapters.get(venue);

  return cloneVenueCapabilities({
    venue,
    runtimeStatus: marketAdapter || privateAdapter ? "available" : "type_only",
    readOnly: privateAdapter?.readOnly ?? false,
    notes:
      privateAdapter?.notes ??
      (marketAdapter
        ? [
            "Capabilities describe the current SDK runtime, not the venue's full API surface.",
          ]
        : typeOnlyNotes),
    market: marketAdapter?.marketCapabilities ?? unsupportedMarket,
    account: privateAdapter?.accountCapabilities ?? unsupportedAccount,
    order: privateAdapter?.orderCapabilities ?? {
      ...unsupportedOrder,
      reason: "not_implemented",
    },
  });
}

export function listVenueCapabilitiesSnapshots(
  registry: VenueCapabilityAdapterRegistry,
): VenueCapabilities[] {
  return SUPPORTED_VENUES.map((venue) =>
    getVenueCapabilitiesSnapshot(venue, registry),
  );
}

function cloneVenueCapabilities(
  capabilities: VenueCapabilities,
): VenueCapabilities {
  return {
    ...capabilities,
    notes: [...capabilities.notes],
    market: {
      ...capabilities.market,
      marketTypes: [...capabilities.market.marketTypes],
    },
    account: {
      ...capabilities.account,
    },
    order: {
      ...capabilities.order,
      orderTypes: [...capabilities.order.orderTypes],
      timeInForce: [...capabilities.order.timeInForce],
    },
  };
}
