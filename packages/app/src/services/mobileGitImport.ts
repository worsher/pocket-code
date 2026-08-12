import {
  normalizeGitRemote,
  runImportPipeline,
  type ImportPipelineResult,
  type ImportProbe,
} from "@pocket-code/workspace-core";
import type { AppSettings } from "../store/settings";
import type { Project } from "../store/projects";
import { cloneGitIntoWorkspaceRoot, probeGitRemote, resolveGitWorkspaceHead } from "./gitService";
import {
  assertMobileImportSpace,
  commitManagedMobileImport,
  createMobileImportStagingDirectory,
  getExistingImportSources,
  rollbackManagedMobileImport,
  type MobileStagedImport,
} from "./mobileDirectoryImport";

export interface MobileGitProbe extends ImportProbe {
  readonly importMode: "git";
  readonly sourceKind: "git";
  readonly gitUrl: string;
}

export type MobileGitImportResult = ImportPipelineResult<MobileGitProbe, Project>;

function projectNameFromRemote(normalizedRemote: string): string {
  return normalizedRemote.split("/").filter(Boolean).at(-1) || "Git project";
}

export async function importMobileGit(args: {
  url: string;
  settings: AppSettings;
  credentialProfileId?: string;
  sourceDeviceId: string;
  projects: readonly Project[];
  allowWeakDuplicate?: boolean;
  commitProject(project: Project): Promise<void>;
}): Promise<MobileGitImportResult> {
  return runImportPipeline({
    input: args.url,
    existingSources: getExistingImportSources(args.projects),
    allowWeakDuplicate: args.allowWeakDuplicate,
    adapter: {
      async probe(url): Promise<MobileGitProbe> {
        const remote = await probeGitRemote(url, args.settings, args.credentialProfileId);
        const normalizedRemote = normalizeGitRemote(remote.url);
        return {
          importMode: "git",
          sourceKind: "git",
          sourceDeviceId: args.sourceDeviceId,
          suggestedName: projectNameFromRemote(normalizedRemote),
          canonicalLocator: remote.url,
          gitRemote: remote.url,
          sourceSnapshot: remote.head,
          estimatedBytes: 0,
          gitUrl: remote.url,
        };
      },
      async stage(probe): Promise<MobileStagedImport> {
        // Remote repository size is not advertised by the Git smart protocol;
        // reserve the safety buffer and still clean staging on ENOSPC/failure.
        assertMobileImportSpace(0);
        const staging = createMobileImportStagingDirectory();
        try {
          const stagedSnapshot = await cloneGitIntoWorkspaceRoot(
            probe.gitUrl,
            args.settings,
            staging.uri,
            args.credentialProfileId
          );
          return { directory: staging, stagedSnapshot };
        } catch (error) {
          if (staging.exists) staging.delete();
          throw error;
        }
      },
      async verify(_probe, staged) {
        return resolveGitWorkspaceHead(staged.directory.uri);
      },
      async commit({ probe, staged, identity, verifiedSnapshot }) {
        return commitManagedMobileImport({
          probe,
          staged,
          identity,
          verifiedSnapshot,
          writeBackPolicy: "git",
          gitUrl: probe.gitUrl,
          gitCredentialProfileId: args.credentialProfileId,
          commitProject: args.commitProject,
        });
      },
      rollback: rollbackManagedMobileImport,
    },
  });
}
