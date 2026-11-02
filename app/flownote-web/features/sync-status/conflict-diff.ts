//! Line-level three-way diff used by the conflict dialog.
//!
//! Computes replacement hunks of local-vs-base and remote-vs-base with an
//! LCS, then walks the base to compose display segments: untouched context,
//! local-only edits, remote-only edits, and regions where both sides changed
//! (shown stacked so the user can decide which side wins).

export interface DiffSegment {
  kind: 'context' | 'local' | 'remote' | 'both';
  /** Local-side lines (context repeats the shared text). */
  localLines: string[];
  /** Remote-side lines (empty for local-only segments and vice versa). */
  remoteLines: string[];
}

export interface ConflictDiff {
  segments: DiffSegment[];
  /** True when neither side differs from the base (nothing to decide). */
  identical: boolean;
}

/** Replacement hunk against base: base[start..end) becomes `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Line guard so the LCS table stays bounded on huge notes. */
const MAX_LINES = 4000;
/** Unchanged lines shown around each change block. */
const CONTEXT_LINES = 2;

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Replacement hunks turning `base` into `modified`, in base order. */
function lcsHunks(base: string[], modified: string[]): Hunk[] {
  const n = base.length;
  const m = modified.length;
  if (n === 0) {
    return m === 0 ? [] : [{ start: 0, end: 0, lines: modified }];
  }
  if (m === 0) {
    return [{ start: 0, end: n, lines: [] }];
  }
  // Too large for a full DP table: degrade to one whole-file replacement.
  if ((n + 1) * (m + 1) > 16_000_000 || n > MAX_LINES || m > MAX_LINES) {
    return [{ start: 0, end: n, lines: modified }];
  }

  // dp[i][j] = LCS length of base[i..) and modified[j..)
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = base[i] === modified[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Collect matched base-line indices; the gaps between them are the hunks.
  const matchedBase: number[] = [];
  const matchedMod: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === modified[j]) {
      matchedBase.push(i);
      matchedMod.push(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const hunks: Hunk[] = [];
  let basePos = 0;
  let modPos = 0;
  for (let k = 0; k <= matchedBase.length; k++) {
    const nextBase = k < matchedBase.length ? matchedBase[k] : n;
    const nextMod = k < matchedMod.length ? matchedMod[k] : m;
    if (nextBase > basePos || nextMod > modPos) {
      hunks.push({
        start: basePos,
        end: nextBase,
        lines: modified.slice(modPos, nextMod),
      });
    }
    basePos = nextBase + 1;
    modPos = nextMod + 1;
  }
  return hunks;
}

/**
 * Direct local-vs-remote diff, used when the recorded base is degraded
 * (the server could not resolve it and substituted its own content). A
 * three-way diff against a pseudo-base would attribute every remote line
 * to "unchanged", hiding the cloud side entirely — so attribute-free
 * two-way segments are the honest fallback.
 */
export function composeTwoWayDiff(local: string, remote: string): ConflictDiff {
  const l = splitLines(local);
  const r = splitLines(remote);
  const hunks = lcsHunks(l, r);
  if (hunks.length === 0) {
    return { segments: [], identical: true };
  }

  const segments: DiffSegment[] = [];
  const pushContext = (end: number) => {
    if (end > pos) {
      const context = l.slice(pos, end);
      segments.push({ kind: 'context', localLines: context, remoteLines: context });
    }
  };

  let pos = 0;
  for (let k = 0; k < hunks.length; k++) {
    const hunk = hunks[k];
    // Trim the first context block to its tail and the last one to its
    // head so the view opens on the change; interior blocks stay full.
    const isFirst = k === 0 && segments.length === 0;
    if (isFirst && hunk.start > CONTEXT_LINES) {
      pushContext(hunk.start);
      const head = segments.pop()!;
      head.localLines = head.localLines.slice(-CONTEXT_LINES);
      head.remoteLines = head.localLines;
      segments.push(head);
    } else {
      pushContext(hunk.start);
    }
    segments.push({
      kind: 'both',
      localLines: l.slice(hunk.start, hunk.end),
      remoteLines: hunk.lines,
    });
    pos = hunk.end;
  }
  pushContext(Math.min(l.length, pos + CONTEXT_LINES));
  return { segments, identical: false };
}

export function composeConflictDiff(base: string, local: string, remote: string): ConflictDiff {
  const b = splitLines(base);
  const l = splitLines(local);
  const r = splitLines(remote);
  const localHunks = lcsHunks(b, l);
  const remoteHunks = lcsHunks(b, r);

  if (localHunks.length === 0 && remoteHunks.length === 0) {
    return { segments: [], identical: true };
  }

  const segments: DiffSegment[] = [];
  let basePos = 0;
  let li = 0;
  let ri = 0;

  const pushContext = (end: number) => {
    if (end > basePos) {
      const context = b.slice(basePos, end);
      segments.push({ kind: 'context', localLines: context, remoteLines: context });
      basePos = end;
    }
  };

  while (li < localHunks.length || ri < remoteHunks.length) {
    const nextLocal = li < localHunks.length ? localHunks[li].start : Number.MAX_SAFE_INTEGER;
    const nextRemote = ri < remoteHunks.length ? remoteHunks[ri].start : Number.MAX_SAFE_INTEGER;

    if (nextLocal < nextRemote) {
      const hunk = localHunks[li];
      // A remote hunk starting inside this local hunk's base range means
      // both sides touched the same region.
      if (ri < remoteHunks.length && remoteHunks[ri].start < hunk.end) {
        pushContext(Math.max(basePos, hunk.start - CONTEXT_LINES));
        // Consume the whole overlapping run from both sides.
        let end = Math.max(hunk.end, remoteHunks[ri].end);
        const localLines = [...hunk.lines];
        const remoteLines = [...remoteHunks[ri].lines];
        li++;
        ri++;
        let grew = true;
        while (grew) {
          grew = false;
          if (li < localHunks.length && localHunks[li].start < end) {
            end = Math.max(end, localHunks[li].end);
            localLines.push(...localHunks[li].lines);
            li++;
            grew = true;
          }
          if (ri < remoteHunks.length && remoteHunks[ri].start < end) {
            end = Math.max(end, remoteHunks[ri].end);
            remoteLines.push(...remoteHunks[ri].lines);
            ri++;
            grew = true;
          }
        }
        segments.push({ kind: 'both', localLines, remoteLines });
        basePos = end;
      } else {
        pushContext(Math.max(basePos, hunk.start - CONTEXT_LINES));
        segments.push({ kind: 'local', localLines: hunk.lines, remoteLines: [] });
        basePos = hunk.end;
        li++;
      }
    } else if (nextRemote < nextLocal) {
      const hunk = remoteHunks[ri];
      pushContext(Math.max(basePos, hunk.start - CONTEXT_LINES));
      segments.push({ kind: 'remote', localLines: [], remoteLines: hunk.lines });
      basePos = hunk.end;
      ri++;
    } else {
      // Both sides replaced the exact same base range.
      const localHunk = localHunks[li];
      const remoteHunk = remoteHunks[ri];
      pushContext(Math.max(basePos, localHunk.start - CONTEXT_LINES));
      segments.push({
        kind: 'both',
        localLines: localHunk.lines,
        remoteLines: remoteHunk.lines,
      });
      basePos = Math.max(localHunk.end, remoteHunk.end);
      li++;
      ri++;
    }
  }

  pushContext(Math.min(b.length, basePos + CONTEXT_LINES));
  // Trim a leading context block down to its tail so the dialog opens on
  // the change, not on the top of the file.
  if (segments.length > 1 && segments[0].kind === 'context') {
    const head = segments[0];
    if (head.localLines.length > CONTEXT_LINES) {
      head.localLines = head.localLines.slice(-CONTEXT_LINES);
      head.remoteLines = head.localLines;
    }
  }
  return { segments, identical: false };
}
