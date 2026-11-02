const PLAIN_TEXT_LANGUAGE = 'plaintext'

/**
 * Detect the most likely language from a code block's source.
 *
 * This deliberately stays small and deterministic: Shiki provides grammar
 * highlighting, but it does not provide source-language detection. Strong
 * syntax markers win over generic ones, and ambiguous/unknown text falls
 * back to plain text instead of pretending to know the language.
 */
export function detectCodeLanguage(source: string): string {
  const code = source.trim()
  if (!code) return PLAIN_TEXT_LANGUAGE

  if ((code.startsWith('{') || code.startsWith('[')) && isJson(code)) {
    return 'json'
  }

  const scores = new Map<string, number>()
  const add = (language: string, points: number): void => {
    scores.set(language, (scores.get(language) ?? 0) + points)
  }

  if (/^#!.*\b(?:python|python3)\b/m.test(code)) add('python', 8)
  if (/^#!.*\b(?:bash|sh|zsh)\b/m.test(code)) add('shellscript', 8)
  if (/^#!.*\b(?:node|deno)\b/m.test(code)) add('javascript', 7)

  // Java has several signatures that are uncommon in the other supported
  // languages. These deliberately carry more weight so a Java class with a
  // generic `import` or `for` statement is still identified as Java.
  if (/\bpackage\s+[\w.]+\s*;/.test(code)) add('java', 6)
  if (/\bimport\s+(?:java|javax)\.[\w.]+\s*;/.test(code)) add('java', 7)
  if (/\bpublic\s+(?:final\s+)?class\s+\w+/.test(code)) add('java', 5)
  if (/\bpublic\s+static\s+void\s+main\s*\(/.test(code)) add('java', 7)
  if (/\bSystem\.(?:out|err)\.(?:print|println|printf)\s*\(/.test(code)) add('java', 6)
  if (/\b(?:String|Integer|Boolean|Long|Double|ArrayList)\s+\w+\s*[=;)]/.test(code)) add('java', 2)

  if (/\busing\s+System\s*;/.test(code)) add('csharp', 6)
  if (/\bnamespace\s+[\w.]+/.test(code)) add('csharp', 3)
  if (/\bConsole\.(?:Write|WriteLine|ReadLine)\s*\(/.test(code)) add('csharp', 5)
  if (/\bpublic\s+(?:partial\s+)?class\s+\w+/.test(code)) add('csharp', 2)

  if (/^\s*#include\s*[<"]/m.test(code)) add('cpp', 6)
  if (/\bstd::\w+/.test(code)) add('cpp', 5)
  if (/\b(?:printf|scanf)\s*\(/.test(code)) add('c', 3)
  if (/\bint\s+main\s*\(/.test(code)) add('cpp', 3)

  if (/^\s*package\s+main\s*$/m.test(code)) add('go', 7)
  if (/\bfunc\s+(?:main|\w+)\s*\(/.test(code)) add('go', 4)
  if (/\bfmt\.Print(?:ln|f)?\s*\(/.test(code)) add('go', 5)

  if (/\bfn\s+(?:main|\w+)\s*\(/.test(code)) add('rust', 5)
  if (/\buse\s+std::/.test(code)) add('rust', 6)
  if (/\b(?:let\s+mut|println!)\b/.test(code)) add('rust', 4)

  if (/^\s*(?:def\s+\w+\s*\([^)]*\)|class\s+\w+\s*(?:\([^)]*\))?)\s*:/m.test(code)) add('python', 6)
  if (/^\s*(?:from\s+\w[\w.]*\s+import|import\s+\w[\w.]*)/m.test(code)) add('python', 3)
  if (/\b(?:elif|None|True|False)\b/.test(code)) add('python', 3)
  if (/\bprint\s*\(/.test(code)) add('python', 2)

  if (/^\s*fun\s+(?:main|\w+)\s*\(/m.test(code)) add('kotlin', 6)
  if (/\b(?:val|var)\s+\w+\s*=/.test(code)) add('kotlin', 2)
  if (/\b(?:data\s+class|when)\b/.test(code)) add('kotlin', 4)

  if (/^\s*import\s+(?:Foundation|UIKit|SwiftUI)\b/m.test(code)) add('swift', 7)
  if (/\b(?:let|var)\s+\w+\s*:s*\w+/.test(code)) add('swift', 3)
  if (/\bguard\s+.+\s+else\s*\{/.test(code)) add('swift', 4)

  if (/^\s*<(!doctype\s+html|html|head|body|[\w-]+[\s>])/im.test(code)) add('html', 7)
  if (/<\/?[A-Za-z][^>]*>/.test(code)) add('xml', 3)
  if (/[.#]?[\w-]+\s*\{[^{}]*(?:color|display|margin|padding)\s*:/s.test(code)) add('css', 5)
  if (/^\s*\$[\w-]+\s*:/m.test(code)) add('scss', 4)

  if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|DATABASE)|ALTER\s+TABLE)\b/im.test(code)) add('sql', 7)
  if (/\b(?:FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY)\b/i.test(code)) add('sql', 2)

  if (/^\s*<\?php\b/i.test(code)) add('php', 8)
  if (/\$[A-Za-z_]\w*\s*=/.test(code)) add('php', 2)
  if (/^\s*(?:class\s+\w+|def\s+\w+\s*\()/m.test(code) && /\bend\s*$/m.test(code)) add('ruby', 5)
  if (/\b(?:puts|require)\s+['"]/.test(code)) add('ruby', 3)

  if (/^\s*(?:const|let|var)\s+\w+\s*=/.test(code)) add('javascript', 4)
  if (/\b(?:import\s+.+\s+from|export\s+(?:default\s+)?|console\.log)\b/.test(code)) add('javascript', 4)
  if (/(?:=>|===|!==|\?\?)/.test(code)) add('javascript', 3)
  if (/\b(?:interface|type)\s+\w+\s*(?:=|\{)/.test(code)) add('typescript', 5)
  if (/\b(?:as\s+const|readonly|Record<|Partial<)\b/.test(code)) add('typescript', 3)
  if (/<[A-Z][\w.]*(?:\s[^>]*)?>/.test(code)) add('tsx', 5)

  if (/^\s*(?:version:\s*['"]?3|services:|volumes:|networks:)\s*$/m.test(code)) add('yaml', 5)
  if (/^\s*[{[]/.test(code) && /["']?\w+["']?\s*:/.test(code)) add('yaml', 2)
  if (/^\s*(?:FROM|RUN|CMD|ENTRYPOINT|COPY|WORKDIR)\s+\S+/m.test(code)) add('docker', 6)
  if (/^\s*\[[\w.-]+\]\s*$/m.test(code) && /^\s*[\w.-]+\s*=\s*\S+/m.test(code)) add('ini', 4)
  if (/^\s*(?:query|mutation|subscription)\s*\w*\s*\{/m.test(code)) add('graphql', 6)

  if (/^\s*(?:\$ |>|\.\/|#!.*\b(?:bash|sh|zsh)\b)/m.test(code)) add('shellscript', 4)

  let bestLanguage = PLAIN_TEXT_LANGUAGE
  let bestScore = 0
  for (const [language, score] of scores) {
    if (score > bestScore) {
      bestLanguage = language
      bestScore = score
    }
  }

  return bestScore >= 4 ? bestLanguage : PLAIN_TEXT_LANGUAGE
}

function isJson(source: string): boolean {
  try {
    const value: unknown = JSON.parse(source)
    return typeof value === 'object' && value !== null
  } catch {
    return false
  }
}
