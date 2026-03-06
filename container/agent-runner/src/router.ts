export interface Models {
    haiku: string;
    sonnet: string;
    opus: string;
}

export function selectModel(prompt: string, models: Models): string {
    const lower = prompt.toLowerCase();
    const wordCount = prompt.trim().split(/\s+/).length;

    // Direct model override: user explicitly requests a model by name
    if (lower.includes('haiku')) {
        return models.haiku || models.sonnet;
    }
    if (lower.includes('opus')) {
        return models.opus || models.sonnet;
    }
    if (lower.includes('sonnet')) {
        return models.sonnet;
    }

    // Opus: important/complex tasks
    const opusKeywords = [
        'important',
        'urgent',
        'decision',
        'strategy',
        'meeting recording',
        'external email',
    ];
    if (opusKeywords.some((k) => lower.includes(k))) {
        return models.opus || models.sonnet;
    }

    // Haiku: short prompts (< 15 words) or triage-type tasks
    const haikuKeywords = ['triage', 'classify', 'status', 'lookup', 'yes/no'];
    if (wordCount < 15 || haikuKeywords.some((k) => lower.includes(k))) {
        return models.haiku || models.sonnet;
    }

    // Default: Sonnet
    return models.sonnet;
}
