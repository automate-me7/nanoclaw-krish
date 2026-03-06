import { describe, it, expect } from 'vitest';
import { selectModel, Models } from './router.js';

describe('selectModel', () => {
    const mockModels: Models = {
        haiku: 'claude-3-5-haiku-20241022',
        sonnet: 'claude-3-5-sonnet-20241022',
        opus: 'claude-3-opus-20240229',
    };

    it('returns haiku for explicitly requested haiku', () => {
        expect(selectModel('use haiku to summarize this', mockModels)).toBe(mockModels.haiku);
    });

    it('returns opus for explicitly requested opus', () => {
        expect(selectModel('use opus to write a long story', mockModels)).toBe(mockModels.opus);
    });

    it('returns sonnet for explicitly requested sonnet', () => {
        expect(selectModel('please use sonnet', mockModels)).toBe(mockModels.sonnet);
    });

    it('returns haiku for short prompts (< 15 words)', () => {
        expect(selectModel('what is your name?', mockModels)).toBe(mockModels.haiku);
    });

    it('returns haiku for triage keywords', () => {
        const longPrompt = 'Can you please check the status of the following build and classify it accordingly since it seems to be taking way too long to finish. This is just a test to make sure it routes properly.';
        expect(selectModel(longPrompt, mockModels)).toBe(mockModels.haiku);
    });

    it('returns opus for urgent/complex keywords', () => {
        const longPrompt = 'Please write a new strategy document because there is an important meeting recording tomorrow that we must prepare for. This must be an extremely robust document with lots of facts.';
        expect(selectModel(longPrompt, mockModels)).toBe(mockModels.opus);
    });

    it('returns sonnet for long prompts that do not match any keywords', () => {
        const longPrompt = 'Please tell me a long story about a dog that goes to the moon. He decides to pack a very large suitcase filled with exactly seventeen different types of kibble and roughly six bones.';
        expect(selectModel(longPrompt, mockModels)).toBe(mockModels.sonnet);
    });

    it('falls back to sonnet if requested model is unavailable', () => {
        const fallbackModels: Models = {
            haiku: '',
            sonnet: 'claude-3-5-sonnet-20241022',
            opus: '',
        };
        expect(selectModel('use opus', fallbackModels)).toBe(fallbackModels.sonnet);
        expect(selectModel('use haiku', fallbackModels)).toBe(fallbackModels.sonnet);
        expect(selectModel('this is urgent', fallbackModels)).toBe(fallbackModels.sonnet);
        expect(selectModel('short', fallbackModels)).toBe(fallbackModels.sonnet);
    });
});
