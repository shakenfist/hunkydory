# The one ambiguous case

Consider the end of a hunk:

```diff
@@ -52,5 +52,6 @@ LABEL maintainer="{{ maintainer }}"
 {% endif %}

 {% set ironic_conductor_pip_packages = [
+    '/ironic[ansible,networking_generic_switch]',
     'ironic-staging-drivers',
 ] %}
 
diff --git a/releasenotes/notes/whatever.yaml b/releasenotes/notes/whatever.yaml
```

Count the body and you get 6 old lines and 7 new. The header says 5 and 6.
Neither is a typo: there is a blank line just before `diff --git`, and whether
it belongs to this hunk or is merely separating the two files cannot be decided
from the text.

git resolves it by construction. It reads a hunk by consuming exactly as many
lines as the header declares, then stops and ignores whatever follows. So the
header is not a *description* of the body that can be recomputed from it — it
is an instruction about how much of the body to read.

That is a problem for any tool recounting after the fact. patchutils'
`recountdiff` guesses wrong here, on several real patches.

## What we do

`resolveCounts` breaks the tie using the header it was handed. It computes the
counts for each possible number of ignored trailing blank lines, and if one of
those readings matches the declared counts exactly on **both** sides, that was
the author's intent and it is preserved.

Once the body has been edited no reading matches any more, and it falls back to
counting every line. That is deliberate: over-counting makes git reject the
patch loudly, while under-counting makes it silently apply the wrong content.
Failing safe means erring large.

The exception is a hunk whose old side starts at 0, as a file creation's does.
That side must be empty, so a reading that counts a trailing blank into it is
not a reading at all, and the fallback takes the first one that leaves it
empty. Over-counting is only the safe direction while the result is still a
header git can parse.

Nor is there any ambiguity right before another hunk of the same file. git
reads every line up to the next `@@` as part of the hunk before it, and stops
at nothing in between, so a blank there is in the hunk whatever the old header
said. Without this, a blank typed at the end of such a hunk was left out by the
tie-break -- the old header still matched without it -- and git rejected the
patch with `patch fragment without header`.

That holds only for a hunk with context of its own. In a hunk with none, as in
a patch made with `git diff -U0`, or whose only context is itself blank, the
counted blank would be all the context git had, and an insertion would go
silently at the first run of blank lines it came to. A deleted line pins a
hunk too, but the rule asks for context and goes no further than it must:
there the old reading stands, and git rejects the patch, which is the better
way to be wrong.

Even with context, counting the blank in means the hunk only fits where the
file has a blank line after it, so git searches for somewhere that does. That
is safe exactly as far as the rest of the hunk's context is distinctive, which
is why a stray blank is still best deleted rather than left to a recount.

In practice this is why a patch git accepts is never rewritten — the tie-break
reproduces whatever the file already said — while an edited one gets a header
that is, at worst, conservative.

## What cannot be fixed this way

If you delete a *context* line from a hunk, nothing in the resulting text
records that it was ever there. Any recounter will happily produce a
self-consistent header for a patch that no longer matches the source.

The only defence is a reference copy from before the edit, which is what
patchutils' `rediff` uses. An editor extension has one available in principle —
the undo history — but does not use it today.
