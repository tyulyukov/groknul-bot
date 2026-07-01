export interface PhotoCandidateSource {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  snippet?: string;
  thumbnailUrl?: string;
  source?: string;
  resolution?: string;
  engine?: string;
  score?: number;
}

export interface PhotoCandidate extends PhotoCandidateSource {
  id: string;
  confidence: number;
  matchedTerms: string[];
  reason: string;
}

export interface PhotoCandidateResolution {
  query: string;
  selected: PhotoCandidate[];
  rejected: PhotoCandidate[];
}

export interface ResolvePhotoCandidatesInput {
  query: string;
  results: PhotoCandidateSource[];
  limit?: number;
  requiredTerms?: string[];
  negativeTerms?: string[];
}

const MAX_SELECTED_PHOTOS = 10;
const MIN_CONFIDENCE = 0.45;
const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'image',
  'of',
  'photo',
  'picture',
  'pic',
  'pics',
  'please',
  'send',
  'show',
  'the',
  'картинка',
  'картинку',
  'покажи',
  'пришли',
  'фото',
  'зображення',
  'надішли',
]);
const UNSAFE_PHOTO_TERMS = [
  'adult',
  'explicit',
  'gore',
  'naked',
  'nsfw',
  'nude',
  'porn',
  'shock',
  'xxx',
];

export const resolvePhotoCandidates = (
  input: ResolvePhotoCandidatesInput,
): PhotoCandidateResolution => {
  const queryTerms = normalizeTerms([input.query], { dropStopWords: true });
  const requiredTerms = mergeTerms(
    normalizeTerms(input.requiredTerms ?? []),
    inferRequiredTerms(queryTerms),
  );
  const negativeTerms = normalizeTerms(input.negativeTerms ?? []);
  const limit = clampLimit(input.limit ?? 3);
  const seenImageUrls = new Set<string>();
  const selected: PhotoCandidate[] = [];
  const rejected: PhotoCandidate[] = [];

  for (const [index, result] of input.results.entries()) {
    const base = toCandidateBase(result, index);
    if (!base) continue;

    if (seenImageUrls.has(base.imageUrl)) continue;
    seenImageUrls.add(base.imageUrl);

    const candidateTerms = normalizeTermSet([
      base.title,
      base.snippet,
      base.source,
      base.sourceUrl,
      base.imageUrl,
    ]);
    const matchedQueryTerms = queryTerms.filter((term) =>
      candidateTerms.has(term),
    );
    const matchedRequiredTerms = requiredTerms.filter((term) =>
      candidateTerms.has(term),
    );
    const missingRequiredTerms = requiredTerms.filter(
      (term) => !matchedRequiredTerms.includes(term),
    );
    const matchedNegativeTerms = negativeTerms.filter((term) =>
      candidateTerms.has(term),
    );
    const matchedUnsafeTerms = UNSAFE_PHOTO_TERMS.filter((term) =>
      candidateTerms.has(term),
    );

    if (missingRequiredTerms.length > 0) {
      rejected.push({
        ...base,
        confidence: 0,
        matchedTerms: matchedQueryTerms,
        reason: `missing required: ${missingRequiredTerms.join(', ')}`,
      });
      continue;
    }

    if (matchedUnsafeTerms.length > 0) {
      rejected.push({
        ...base,
        confidence: 0,
        matchedTerms: matchedQueryTerms,
        reason: `unsafe metadata: ${matchedUnsafeTerms.join(', ')}`,
      });
      continue;
    }

    if (matchedNegativeTerms.length > 0) {
      rejected.push({
        ...base,
        confidence: 0,
        matchedTerms: matchedQueryTerms,
        reason: `matched negative: ${matchedNegativeTerms.join(', ')}`,
      });
      continue;
    }

    const confidence = calculateConfidence({
      queryTermsCount: queryTerms.length,
      matchedQueryTermsCount: matchedQueryTerms.length,
      requiredTermsCount: requiredTerms.length,
      matchedRequiredTermsCount: matchedRequiredTerms.length,
      score: base.score,
      title: base.title,
      requiredTerms,
    });
    const candidate: PhotoCandidate = {
      ...base,
      confidence,
      matchedTerms: Array.from(
        new Set([...matchedRequiredTerms, ...matchedQueryTerms]),
      ),
      reason: [
        matchedRequiredTerms.length
          ? `required: ${matchedRequiredTerms.join(', ')}`
          : undefined,
        matchedQueryTerms.length
          ? `query: ${matchedQueryTerms.join(', ')}`
          : undefined,
        `confidence: ${confidence.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join('; '),
    };

    if (confidence < MIN_CONFIDENCE) {
      rejected.push({
        ...candidate,
        reason: `low confidence; ${candidate.reason}`,
      });
      continue;
    }

    selected.push(candidate);
  }

  selected.sort((a, b) => b.confidence - a.confidence);

  return {
    query: input.query,
    selected: selected.slice(0, limit),
    rejected,
  };
};

const toCandidateBase = (
  result: PhotoCandidateSource,
  index: number,
): (PhotoCandidateSource & { id: string }) | null => {
  if (!isHttpUrl(result.imageUrl)) return null;

  return {
    ...result,
    id: `candidate-${index + 1}`,
    title: result.title.trim(),
    imageUrl: result.imageUrl.trim(),
    sourceUrl: result.sourceUrl.trim(),
    snippet: result.snippet?.trim(),
    thumbnailUrl: result.thumbnailUrl?.trim(),
    source: result.source?.trim(),
    resolution: result.resolution?.trim(),
    engine: result.engine?.trim(),
  };
};

const calculateConfidence = (input: {
  queryTermsCount: number;
  matchedQueryTermsCount: number;
  requiredTermsCount: number;
  matchedRequiredTermsCount: number;
  score?: number;
  title: string;
  requiredTerms: string[];
}): number => {
  const requiredRatio =
    input.requiredTermsCount > 0
      ? input.matchedRequiredTermsCount / input.requiredTermsCount
      : 0;
  const queryRatio =
    input.queryTermsCount > 0
      ? input.matchedQueryTermsCount / input.queryTermsCount
      : 0;
  const scoreBoost =
    typeof input.score === 'number' && Number.isFinite(input.score)
      ? Math.min(0.1, Math.max(0, input.score) / 100)
      : 0;
  const titleText = normalizeText([input.title]);
  const titleBoost = input.requiredTerms.some((term) =>
    titleText.includes(term),
  )
    ? 0.1
    : 0;

  const matchScore =
    input.requiredTermsCount > 0
      ? requiredRatio * 0.5 + queryRatio * 0.4
      : queryRatio * 0.75;

  return Math.min(1, matchScore + scoreBoost + titleBoost);
};

const normalizeTerms = (
  values: string[],
  options: { dropStopWords?: boolean } = {},
): string[] =>
  Array.from(
    new Set(
      values
        .flatMap((value) => normalizeText([value]).split(' '))
        .map((value) => value.trim())
        .filter((value) => value.length > 1)
        .filter(
          (value) => !options.dropStopWords || !QUERY_STOP_WORDS.has(value),
        ),
    ),
  );

const normalizeText = (values: Array<string | undefined>): string =>
  values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeTermSet = (values: Array<string | undefined>): Set<string> =>
  new Set(normalizeText(values).split(' ').filter(Boolean));

const mergeTerms = (...groups: string[][]): string[] =>
  Array.from(new Set(groups.flat()));

const inferRequiredTerms = (queryTerms: string[]): string[] =>
  queryTerms.filter((term) => /\d/.test(term) || term.length >= 5);

const clampLimit = (value: number): number =>
  Math.max(1, Math.min(MAX_SELECTED_PHOTOS, Math.floor(value)));

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};
