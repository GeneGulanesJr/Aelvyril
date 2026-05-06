export interface ReviewIssue {
  file: string;
  line?: number;
  severity: 'critical' | 'warning' | 'suggestion';
  message: string;
}

export interface ReviewDecision {
  approved: boolean;
  summary: string;
  notes: string;
  issues: ReviewIssue[];
}

export function parseReviewDecision(raw: string): ReviewDecision {
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, raw];
  const jsonStr = jsonMatch[1] || raw;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    throw new Error('Invalid JSON in review agent response');
  }

  if (typeof parsed.approved !== 'boolean') {
    throw new Error('Review decision missing required "approved" boolean field');
  }

  return {
    approved: parsed.approved,
    summary: (parsed.summary as string) ?? '',
    notes: (parsed.notes as string) ?? '',
    issues: (parsed.issues as ReviewIssue[]) ?? [],
  };
}
