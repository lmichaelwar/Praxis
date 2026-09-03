import type { JobCreateRequest } from "./schema";

export interface ProviderPricing {
  imageLowUsd: number;
  imageMediumUsd: number;
  imageHighUsd: number;
  speechUsdPerMillionCharacters: number;
}

export const DEFAULT_PROVIDER_PRICING: ProviderPricing = {
  imageLowUsd: 0.013,
  imageMediumUsd: 0.05,
  imageHighUsd: 0.2,
  speechUsdPerMillionCharacters: 15,
};

const roundUsd = (value: number) => Math.ceil(value * 1_000_000) / 1_000_000;

export const estimateJobCostUsd = (
  request: JobCreateRequest,
  pricing: ProviderPricing = DEFAULT_PROVIDER_PRICING,
): number => {
  if (request.jobType === "image.generate") {
    if (request.request.provider === "fake") return 0;
    if (request.request.quality === "high") return pricing.imageHighUsd;
    if (request.request.quality === "medium") return pricing.imageMediumUsd;
    return pricing.imageLowUsd;
  }
  if (request.jobType === "speech.generate") {
    if (request.request.provider === "fake") return 0;
    const boundedCharacters = request.request.text?.length ?? 4_096;
    return roundUsd((boundedCharacters / 1_000_000) * pricing.speechUsdPerMillionCharacters);
  }
  return 0;
};
