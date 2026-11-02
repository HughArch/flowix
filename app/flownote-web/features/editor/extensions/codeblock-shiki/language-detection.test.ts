import { describe, expect, it } from 'vitest'

import { detectCodeLanguage } from './language-detection'

describe('code block language detection', () => {
  it('detects Java from common class and output syntax', () => {
    expect(detectCodeLanguage(`public class Main {
  public static void main(String[] args) {
    System.out.println("Hello");
  }
}`)).toBe('java')
  })

  it('detects JSON before generic brace-based languages', () => {
    expect(detectCodeLanguage('{"name":"Flownote","enabled":true}')).toBe('json')
  })

  it('falls back to plain text for ambiguous content', () => {
    expect(detectCodeLanguage('This is a regular sentence.')).toBe('plaintext')
  })
})
