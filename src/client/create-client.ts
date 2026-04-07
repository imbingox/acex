import type { AcexClient, CreateClientOptions } from "../types/index.ts";
import { AcexClientImpl } from "./runtime.ts";

export function createClient(options?: CreateClientOptions): AcexClient {
  return new AcexClientImpl(options);
}
