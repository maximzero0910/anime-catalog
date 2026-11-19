import { livenessResponse } from '../../../lib/health-response';

export const prerender = false;

export function GET(): Response { return livenessResponse(); }
