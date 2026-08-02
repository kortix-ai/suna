'use client';

import {
  getProjectDetail,
  listMarketplaceCatalogItems,
  type AgentProfile,
  type AgentProfileSkill,
} from '@kortix/sdk';
import { type useAgentProfileMutations } from '@kortix/sdk/react';
import {
  ArrowDownIcon,
  CheckCircleIcon,
  FileZipIcon,
  GithubLogoIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsContent, TabsListCompact, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';

import { activeProfileSections } from './agent-profile-utils';

type ProfileMutations = ReturnType<typeof useAgentProfileMutations>;

interface SkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  mutations: ProfileMutations;
  onConflict: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function skillOriginLabel(skill: AgentProfileSkill): string {
  if (skill.origin === 'project') return 'Project';
  if (skill.origin === 'marketplace') return 'Marketplace';
  if (skill.origin === 'github') return 'GitHub';
  if (skill.origin === 'generated') return 'Created here';
  return 'Imported';
}

export function AgentProfileSkillsDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: SkillsDialogProps) {
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState('library');
  const [query, setQuery] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [briefName, setBriefName] = useState('');
  const [brief, setBrief] = useState('');
  const sections = activeProfileSections(profile);
  const skills = useMemo(() => sections.skills ?? [], [sections.skills]);
  const selectedSlugs = useMemo(() => new Set(skills.map((skill) => skill.slug)), [skills]);
  const project = useQuery({
    queryKey: ['project-detail', profile.project_id],
    queryFn: () => getProjectDetail(profile.project_id),
    enabled: open,
    staleTime: 30_000,
  });
  const marketplace = useQuery({
    queryKey: ['agent-profile-skill-marketplace', query],
    queryFn: () =>
      listMarketplaceCatalogItems({
        type: 'registry:skill',
        query: query.trim() || undefined,
        limit: 30,
      }),
    enabled: open && tab === 'marketplace',
    staleTime: 30_000,
  });

  const handleError = (error: unknown, fallback: string) => {
    onConflict();
    errorToast(errorMessage(error, fallback));
  };

  const updateSkills = async (next: AgentProfileSkill[], message: string) => {
    try {
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: { skills: next },
      });
      successToast(message);
    } catch (error) {
      handleError(error, 'Skill draft could not be updated');
    }
  };

  const addProjectSkill = (item: { name: string; description: string | null }) => {
    const skill: AgentProfileSkill = {
      slug: item.name,
      name: item.name,
      description: item.description,
      origin: 'project',
      status: 'pending_publication',
    };
    void updateSkills(
      [...skills.filter((entry) => entry.slug !== skill.slug), skill],
      `${item.name} added to the draft`,
    );
  };

  const removeSkill = (skill: AgentProfileSkill) => {
    void updateSkills(
      skills.filter((entry) => entry.slug !== skill.slug),
      `${skill.name} removed from the draft`,
    );
  };

  const importArchive = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(skill|zip)$/i.test(file.name)) {
      errorToast('Choose a .skill or ZIP archive.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      errorToast('Skill archives must be 10 MB or smaller.');
      return;
    }
    try {
      await mutations.importSkillArchive.mutateAsync({
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      });
      successToast(`${file.name} added to the draft`);
      if (archiveInputRef.current) archiveInputRef.current.value = '';
    } catch (error) {
      handleError(error, 'Skill archive could not be imported');
    }
  };

  const importGitHub = async () => {
    try {
      await mutations.importGitHubSkill.mutateAsync({ url: githubUrl.trim() });
      setGithubUrl('');
      successToast('GitHub skill added to the draft');
    } catch (error) {
      handleError(error, 'GitHub skill could not be imported');
    }
  };

  const generate = async () => {
    try {
      await mutations.generateSkill.mutateAsync({
        name: briefName.trim() || undefined,
        brief: brief.trim(),
      });
      setBriefName('');
      setBrief('');
      successToast('Skill created in the draft');
    } catch (error) {
      handleError(error, 'Skill could not be created');
    }
  };

  const installMarketplace = async (itemId: string, title: string) => {
    try {
      await mutations.installMarketplaceSkill.mutateAsync({ itemId });
      successToast(`${title} added to the draft`);
    } catch (error) {
      handleError(error, 'Marketplace skill could not be installed');
    }
  };

  const stagePending =
    mutations.importSkillArchive.isPending ||
    mutations.importGitHubSkill.isPending ||
    mutations.generateSkill.isPending ||
    mutations.installMarketplaceSkill.isPending;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>Skills</ModalTitle>
          <ModalDescription>Add repeatable methods for {profile.agent_name}.</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[72vh] overflow-y-auto pt-5">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsListCompact className="w-full" aria-label="Skill source">
              <TabsTrigger value="library" className="flex-1">
                Library
              </TabsTrigger>
              <TabsTrigger value="marketplace" className="flex-1">
                Marketplace
              </TabsTrigger>
              <TabsTrigger value="import" className="flex-1">
                Import
              </TabsTrigger>
              <TabsTrigger value="create" className="flex-1">
                Create
              </TabsTrigger>
            </TabsListCompact>

            <TabsContent value="library" className="space-y-6 pt-5">
              <section className="space-y-2" aria-labelledby="selected-skills-heading">
                <h3 id="selected-skills-heading" className="text-sm font-medium">
                  Agent skills
                </h3>
                {skills.length === 0 ? (
                  <div className="border-border flex min-h-20 items-center gap-3 border-y py-4">
                    <WrenchIcon className="text-muted-foreground size-5" />
                    <p className="text-muted-foreground text-sm">No skills assigned.</p>
                  </div>
                ) : (
                  <div className="divide-border divide-y">
                    {skills.map((skill) => (
                      <div key={skill.slug} className="flex min-h-14 items-center gap-3 py-2">
                        <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                          <WrenchIcon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">{skill.name}</p>
                            <Badge
                              size="xs"
                              variant={
                                skill.status === 'pending_publication' ? 'warning' : 'success'
                              }
                            >
                              {skill.status === 'pending_publication' ? 'Draft' : 'Available'}
                            </Badge>
                          </div>
                          <p className="text-muted-foreground mt-0.5 truncate text-xs">
                            {skillOriginLabel(skill)}
                            {skill.description ? ` · ${skill.description}` : ''}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutations.updateDraft.isPending}
                          onClick={() => removeSkill(skill)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2" aria-labelledby="project-skills-heading">
                <h3 id="project-skills-heading" className="text-sm font-medium">
                  Project skills
                </h3>
                {project.isLoading ? (
                  <div className="flex h-20 items-center justify-center">
                    <Loading className="size-4" />
                  </div>
                ) : (project.data?.config.skills ?? []).length === 0 ? (
                  <p className="text-muted-foreground border-border border-y py-4 text-sm">
                    No additional project skills.
                  </p>
                ) : (
                  <div className="divide-border divide-y">
                    {(project.data?.config.skills ?? []).map((item) => {
                      const selected = selectedSlugs.has(item.name);
                      return (
                        <div key={item.name} className="flex min-h-14 items-center gap-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{item.name}</p>
                            {item.description ? (
                              <p className="text-muted-foreground truncate text-xs">
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                          <Button
                            variant={selected ? 'outline' : 'secondary'}
                            size="sm"
                            disabled={selected || mutations.updateDraft.isPending}
                            onClick={() => addProjectSkill(item)}
                          >
                            {selected ? (
                              <CheckCircleIcon className="size-3.5" />
                            ) : (
                              <ArrowDownIcon className="size-3.5" />
                            )}
                            {selected ? 'Added' : 'Add'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </TabsContent>

            <TabsContent value="marketplace" className="space-y-4 pt-5">
              <div className="relative">
                <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search skills"
                  className="pl-9"
                />
              </div>
              {marketplace.isLoading ? (
                <div className="flex h-28 items-center justify-center">
                  <Loading className="size-5" />
                </div>
              ) : marketplace.isError ? (
                <p className="text-destructive py-4 text-sm" role="alert">
                  {errorMessage(marketplace.error, 'Marketplace skills could not be loaded')}
                </p>
              ) : (marketplace.data?.items ?? []).length === 0 ? (
                <p className="text-muted-foreground border-border border-y py-5 text-center text-sm">
                  No matching skills.
                </p>
              ) : (
                <div className="divide-border divide-y">
                  {(marketplace.data?.items ?? []).map((item) => {
                    const selected = selectedSlugs.has(
                      String(item.name ?? item.id)
                        .split(':')
                        .at(-1) ?? '',
                    );
                    return (
                      <div key={item.id} className="flex min-h-16 items-center gap-3 py-2.5">
                        <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                          <SparkleIcon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{item.title}</p>
                          {item.description ? (
                            <p className="text-muted-foreground line-clamp-2 text-xs">
                              {String(item.description)}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          variant={selected ? 'outline' : 'secondary'}
                          size="sm"
                          disabled={selected || stagePending}
                          onClick={() => void installMarketplace(item.id, item.title)}
                        >
                          {mutations.installMarketplaceSkill.isPending &&
                          mutations.installMarketplaceSkill.variables?.itemId === item.id ? (
                            <Loading className="size-3" />
                          ) : null}
                          {selected ? 'Added' : 'Install'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="import" className="space-y-6 pt-5">
              <FieldGroup className="gap-5">
                <Field>
                  <FieldLabel>Skill archive</FieldLabel>
                  <button
                    type="button"
                    className="border-border hover:bg-muted/40 focus-visible:ring-ring flex min-h-24 w-full items-center justify-center gap-3 rounded-md border border-dashed px-5 transition-[color,background-color] outline-none focus-visible:ring-2"
                    onClick={() => archiveInputRef.current?.click()}
                    disabled={stagePending}
                  >
                    {mutations.importSkillArchive.isPending ? (
                      <Loading className="size-5" />
                    ) : (
                      <FileZipIcon className="text-muted-foreground size-5" />
                    )}
                    <span className="text-sm font-medium">Choose a .skill or ZIP file</span>
                  </button>
                  <input
                    ref={archiveInputRef}
                    type="file"
                    className="sr-only"
                    aria-label="Skill archive"
                    accept=".skill,.zip,application/zip"
                    onChange={(event) => void importArchive(event.target.files?.[0])}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="skill-github-url">GitHub folder</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id="skill-github-url"
                      type="url"
                      value={githubUrl}
                      onChange={(event) => setGithubUrl(event.target.value)}
                      placeholder="https://github.com/org/repo/tree/main/skill"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!githubUrl.trim() || stagePending}
                      onClick={importGitHub}
                    >
                      {mutations.importGitHubSkill.isPending ? (
                        <Loading className="size-3" />
                      ) : (
                        <GithubLogoIcon className="size-3.5" />
                      )}
                      Import
                    </Button>
                  </div>
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="create" className="pt-5">
              <FieldGroup className="gap-5">
                <Field>
                  <FieldLabel htmlFor="skill-brief-name">Name</FieldLabel>
                  <Input
                    id="skill-brief-name"
                    value={briefName}
                    onChange={(event) => setBriefName(event.target.value)}
                    placeholder="Derived from the brief"
                    maxLength={200}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="skill-brief">What should this skill do?</FieldLabel>
                  <Textarea
                    id="skill-brief"
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    placeholder="Describe the repeatable process, required inputs, and expected output."
                    minHeight={160}
                    maxHeight={320}
                  />
                  <FieldDescription>
                    The draft includes a complete, editable skill.
                  </FieldDescription>
                </Field>
                <Button
                  className="self-end"
                  size="sm"
                  disabled={!brief.trim() || stagePending}
                  onClick={generate}
                >
                  {mutations.generateSkill.isPending ? <Loading className="size-3" /> : null}
                  Create skill
                </Button>
              </FieldGroup>
            </TabsContent>
          </Tabs>
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
