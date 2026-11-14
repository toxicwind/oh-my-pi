import { describe, expect, it } from "bun:test";
import { createGitProofProvider, type GitRepo } from "@oh-my-pi/pi-coding-agent/session/git-proof-provider";

/**
 * T9 — the real git proof provider.
 *
 * The completion gate is only as good as the git state it reads. This provider
 * talks to the native VCS module (the same one the git TUI uses) so the
 * answer comes from git itself: `headSha`, `ls-files` and `status --porcelain`.
 *
 * It must be conservative: a path that cannot be proven tracked is *not*
 * tracked, because the gate's whole value is that it refuses to certify
 * unproven work.
 */

interface RepoStub extends GitRepo {
	headSha: () => Promise<string | undefined>;
	lsFiles: () => Promise<string[]>;
	statusPorcelain: () => Promise<string>;
}

function repoStub(over: Partial<RepoStub> = {}): RepoStub {
	return {
		headSha: async () => "abc123",
		lsFiles: async () => ["docs/a.md", "src/b.ts"],
		statusPorcelain: async () => "",
		...over,
	} as RepoStub;
}

describe("git proof provider", () => {
	it("reports the head sha", async () => {
		const provider = createGitProofProvider({ repo: repoStub() });
		await provider.prepare();
		expect(provider.headSha()).toBe("abc123");
	});

	it("reports a tracked path as tracked", async () => {
		const provider = createGitProofProvider({ repo: repoStub() });
		await provider.prepare();
		expect(provider.isTracked("docs/a.md")).toBe(true);
	});

	it("reports an untracked path as not tracked", async () => {
		const provider = createGitProofProvider({ repo: repoStub() });
		await provider.prepare();
		expect(provider.isTracked("docs/new.md")).toBe(false);
	});

	it("lists the untracked paths from porcelain status", async () => {
		const provider = createGitProofProvider({
			repo: repoStub({ statusPorcelain: async () => "?? docs/new.md\n?? src/c.ts\n" }),
		});
		await provider.prepare();
		expect(provider.untrackedPaths()).toEqual(["docs/new.md", "src/c.ts"]);
	});

	it("treats a modified-but-tracked path as tracked", async () => {
		const provider = createGitProofProvider({
			repo: repoStub({ statusPorcelain: async () => " M docs/a.md\n" }),
		});
		await provider.prepare();
		expect(provider.isTracked("docs/a.md")).toBe(true);
	});

	it("ignores the porcelain status codes that are not untracked", async () => {
		const provider = createGitProofProvider({
			repo: repoStub({ statusPorcelain: async () => "A  staged.md\n M modified.md\nMM both.md\n" }),
		});
		await provider.prepare();
		expect(provider.untrackedPaths()).toEqual([]);
	});

	it("normalizes windows path separators when comparing", async () => {
		const provider = createGitProofProvider({ repo: repoStub() });
		await provider.prepare();
		expect(provider.isTracked("docs\\a.md")).toBe(true);
	});

	it("returns no head when the repository has no commit", async () => {
		const provider = createGitProofProvider({ repo: repoStub({ headSha: async () => undefined }) });
		await provider.prepare();
		expect(provider.headSha()).toBeUndefined();
	});
});
