import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walk up from `start` until a directory containing kortix.yaml is found. */
export function findRepoRoot(start = import.meta.dir): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "kortix.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`kortix.yaml not found above ${start}`);
    dir = parent;
  }
}

export const REPO = process.env.YT_REPO_ROOT ?? findRepoRoot();
export const PIPELINE = join(REPO, "pipeline");
export const KIT = join(REPO, "kit");
export const CHANNEL = join(REPO, "channel");

/** Episodes and build output can be redirected (the smoke test uses a temp dir). */
export const episodesDir = () => process.env.YT_EPISODES_DIR ?? join(REPO, "episodes");
export const buildRoot = () => process.env.YT_BUILD_DIR ?? join(REPO, "build");

export function ep(slug: string) {
  const root = join(episodesDir(), slug);
  const build = join(buildRoot(), slug);
  return {
    slug,
    root,
    state: join(root, "episode.yaml"),
    brief: join(root, "01-brief.json"),
    research: join(root, "02-research"),
    dossier: join(root, "02-research", "dossier.md"),
    claims: join(root, "02-research", "claims.json"),
    factcheck: join(root, "02-research", "fact-check.json"),
    script: join(root, "03-script", "script.json"),
    scriptMd: join(root, "03-script", "script.md"),
    timing: join(root, "03-script", "timing.json"),
    /** The episode's narrator, cast by the sound-editor (`yt cast adopt`). */
    voiceCast: join(root, "03-script", "voice.json"),
    voiceCandidates: join(root, "03-script", "voice-candidates.json"),
    storyboard: join(root, "04-visual", "storyboard.json"),
    styleframes: join(root, "04-visual", "styleframes"),
    scenes: join(root, "05-scenes"),
    scene: (id: string) => join(root, "05-scenes", `${id}.html`),
    sound: join(root, "06-sound", "sound.json"),
    pkg: join(root, "07-package", "package.json"),
    thumbnailHtml: join(root, "07-package", "thumbnail.html"),
    publish: join(root, "08-publish", "publish.json"),
    sourcesMd: join(root, "08-publish", "sources.md"),
    descriptionTxt: join(root, "08-publish", "description.txt"),
    analytics: join(root, "08-publish", "analytics"),
    qa: join(root, "qa"),
    review: (stage: string) => join(root, "qa", `${stage}-review.json`),
    reviewPacket: (gate: string) => join(root, "qa", `gate-${gate}.md`),
    mediaLock: join(root, "media.lock.json"),
    // Heavy media: never in git (see .gitignore); mirrored to object storage.
    media: join(root, "media"),
    narration: join(root, "media", "narration"),
    music: join(root, "media", "music"),
    sfx: join(root, "media", "sfx"),
    sceneAssets: (id: string) => join(root, "media", "scenes", id),
    thumbnailPng: join(root, "media", "thumbnail.png"),
    captions: join(root, "media", "captions.srt"),
    build,
    sceneBuild: (id: string) => join(build, "scenes", id),
    final: join(build, "final.mp4"),
  };
}
export type EpisodePaths = ReturnType<typeof ep>;
