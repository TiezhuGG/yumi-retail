export interface HealthResponse {
  data: { status: 'ok'; service: 'api'; database?: 'connected' };
  requestId: string;
}

// Extend with generated OpenAPI contracts as business endpoints are implemented.
export const applicationStage = 'S0' as const;
