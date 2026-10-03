import * as P from '../rest/projects-client';

export function bindCatalog() {
  const projects = {
    list: P.listProjects,
    listForAccount: P.listProjectsForAccount,
    get: P.getProject,
    detail: P.getProjectDetail,
    create: P.createProject,
    /** Create a project backed by a brand-new Kortix-managed GitHub repo. */
    createRepo: P.createProjectRepo,
    provision: P.provisionProject,
    update: P.updateProject,
    archive: P.archiveProject,
    llmCatalog: P.getProjectLlmCatalog,
    modelPicker: P.getProjectModelPicker,
    modelAccess: P.getProjectModelAccess,
    setModelAccess: P.setProjectModelAccess,
    sandboxHealth: P.getProjectSandboxHealth,
    sandboxTemplates: P.listProjectSandboxTemplates,
    sessions: P.listProjectSessions,
    createSession: P.createProjectSession,
  };

  /** GitHub App installation + repository linking — account-scoped, not project-scoped. */
  const github = {
    linkRepository: P.linkRepository,
    replaceProjectRepository: P.replaceProjectRepository,
    getInstallation: P.getGitHubInstallation,
    listInstallations: P.listGitHubInstallations,
    listLinkableInstallations: P.listLinkableGitHubInstallations,
    listRepositories: P.listGitHubRepositories,
    listRepositoryBranches: P.listGitHubRepositoryBranches,
    linkInstallation: P.linkGitHubInstallation,
    saveInstallation: P.saveGitHubInstallation,
    deleteInstallation: P.deleteGitHubInstallation,
    /** Store this user's GitHub authorization — needed to create a repository
     *  in a personal GitHub account. */
    storeUserToken: P.storeGitHubUserToken,
  };

  /**
   * The instance git backend ("Kortix managed") — one deployment-wide owner
   * plus credential, never an account connection. `backend()` is readable by
   * any authenticated user; `backendRepositories()` is self-host-operator only.
   */
  const gitBackend = {
    get: P.getManagedGitBackend,
    repositories: P.listManagedGitRepositories,
  };

  /** Public share links for a sandbox port (`/v1/p/share`) — sandbox-scoped, not project-scoped. */
  const connectStatus = P.getConnectStatus;

  /**
   * Public marketplace catalog browse (`/v1/marketplace/*`) — top-level and
   * distinct from `project(id).marketplace`, which is install-scoped (commits
   * an item onto a specific project's branch). This is read-only browsing +
   * the authed "add a marketplace source" surface.
   */
  const marketplace = {
    items: (options?: Parameters<typeof P.listMarketplaceCatalogItems>[0]) =>
      P.listMarketplaceCatalogItems(options),
    item: (id: string) => P.getMarketplaceCatalogItem(id),
    itemFile: (id: string, path: string) => P.getMarketplaceCatalogItemFile(id, path),
    marketplaces: () => P.listMarketplaces(),
    featured: () => P.listFeaturedMarketplaces(),
    sources: {
      list: () => P.listMarketplaceSources(),
      add: (input: Parameters<typeof P.addMarketplaceSource>[0]) => P.addMarketplaceSource(input),
      remove: (id: string) => P.removeMarketplaceSource(id),
    },
  };

  return { projects, github, gitBackend, connectStatus, marketplace };
}
