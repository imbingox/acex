import type { Venue } from "./shared.ts";

export interface GetSymbolRiskLimitInput {
  accountId: string;
  symbol: string;
}

export interface FetchRiskLimitsInput {
  accountId: string;
}

export interface SetSymbolLeverageInput {
  accountId: string;
  symbol: string;
  leverage: string;
}

export interface RiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

export interface SymbolLeverageUpdate {
  accountId: string;
  venue: Venue;
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}

export interface RiskLimitTiersFacet {
  source: "missing" | "venue";
  stale: boolean;
  receivedAt?: number;
  items: RiskLimitTier[];
  maxInitialLeverage?: string;
  notionalCoefficient?: string;
}

export interface RiskLimitLeverageFacet {
  lastSet?: SymbolLeverageUpdate;
}

export interface SymbolRiskLimitSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: RiskLimitTiersFacet;
  leverage: RiskLimitLeverageFacet;
  updatedAt: number;
}

export interface RiskLimitManager {
  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot;
  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[];
  fetchSymbolRiskLimit(
    input: GetSymbolRiskLimitInput,
  ): Promise<SymbolRiskLimitSnapshot>;
  fetchRiskLimits(
    input: FetchRiskLimitsInput,
  ): Promise<SymbolRiskLimitSnapshot[]>;
  setSymbolLeverage(
    input: SetSymbolLeverageInput,
  ): Promise<SymbolLeverageUpdate>;
}
