/** Review in the browser: the local diff of a spec, and the specs worth choosing from. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import type { ReviewComment } from './types.ts'

/**
 * What to review, as text: `uncommitted` (the work tree against `HEAD`, untracked files included; `uncommitted:<id>`
 * in conversation `id`'s worktree), a commit (`<sha>`
 * or any ref naming one), a range `<a>...<b>` (what `b` changed since it forked from `a`, as a landing's
 * `<base>...<sha>`), or `branch:<name>` (the branch against the target branch it lands on).
 */
export type ReviewKind = 'uncommitted' | 'commit' | 'range' | 'branch'

/** One changed file. Its hunks are in the diff's `patch` unless it is `binary`, `tooLarge`, `typeChanged` or `symlink`. */
export type ReviewFile = {
  /** The path after the change; the old path for a deleted file. */
  path: string
  /** The path before a rename or copy. */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'
  additions: number
  deletions: number
  binary?: boolean
  /** Its patch was over the per-file cap, or past the whole diff's cap: listed, its hunks left out. */
  tooLarge?: boolean
  /** It became a symlink or stopped being one (Git's `T`): listed, its hunks left out. */
  typeChanged?: boolean
  /** A new symlink whose path or target cannot be written as a plain patch line: listed, its hunks left out. */
  symlink?: boolean
}

export type ReviewDiff = {
  /** The spec shown: as asked, or where a gone `branch:<name>` moved (its landing's range, else `uncommitted`). */
  spec: string
  /** Opaque source id and trusted display metadata, present only for an external source. */
  source?: string
  sourceLabel?: string
  /** Provider-supplied GitHub repository URL; absent means no external compare link. */
  github?: string
  kind: ReviewKind
  /** One line naming what is shown: `Uncommitted changes`, a commit's subject, `main...feature`. */
  title: string
  /** The full shas compared, where there are two commits: the merge base (or parent) and the tip. */
  base?: string
  head?: string
  /** `git diff` output of every file that fits, for `parsePatchFiles` of `@pierre/diffs`. */
  patch: string
  files: ReviewFile[]
  /** The diff was bigger than the whole cap: later files are listed without hunks. */
  truncated?: boolean
}

/** One choice of the range selector. */
export type ReviewRange = {
  spec: string
  group: 'Working tree' | 'Branches' | 'Landings' | 'Commits'
  /** What it is, in a few words: a branch's conversation title, a landing's feature, a commit's subject. */
  label: string
  /** Quiet meta: a short sha, an age. */
  detail?: string
  /** The conversation behind it: a branch's owner, a landing's submitter. */
  conversation?: number
}

/**
 * `{ spec, conversation?, source? }` → the diff of `spec` in the selected trusted source, or in conversation
 * `conversation`'s checkout (its ready worktree, its repository, its cwd), else the project's checkout. Natively, a
 * `branch:<name>` whose ref is gone shows its latest landing, else `uncommitted`, and says so in `spec`. Throws on a
 * spec or ref Git does not know as a commit, and on any part starting with `-`.
 */
export const DiffAction = actionRef<
  { spec: string; conversation?: number; source?: string },
  ReviewDiff
>('review', 'diff')
/**
 * `null` or `{ conversation?, source? }` → the trusted source provider's choices, or recent specs in conversation
 * `conversation`'s checkout (the project's with none): uncommitted, open `ultimate/*` branches, landings and commits.
 */
export const RangesAction = actionRef<
  null | { conversation?: number; source?: string },
  ReviewRange[]
>('review', 'ranges')
/**
 * `{ spec, conversation?, source? }` → the default recipient: the source provider's known recipient, else primary.
 * Without a source: a branch's owner, a landing's submitter, the commit or range head's `Ultimate-Conversation`
 * trailer (read in conversation `conversation`'s checkout, else the project's), else the primary agent.
 */
export const RecipientAction = actionRef<
  { spec: string; conversation?: number; source?: string },
  { conversation: number }
>('review', 'recipient')
/**
 * User only: `{ conversation, spec, comments, note?, source? }` → one `review.comments` input into `conversation`, which wakes
 * or steers it like a typed message. Throws on an unknown conversation or a review over the limits in comments.ts.
 */
export const SendAction = actionRef<
  { conversation: number; spec: string; comments: ReviewComment[]; note?: string; source?: string },
  { conversation: number }
>('review', 'send')
