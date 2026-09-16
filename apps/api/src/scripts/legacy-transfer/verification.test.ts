import {test,expect} from 'bun:test';
import {assertApprovedUnrecoverableWorkspaceException,assertWorkspaceVerified,assertApprovedMissingSandboxException,assertApprovedNoReferenceWorkspaceException} from './verification';
const valid = {workspace_status:'captured',source_sandbox_id:'source-box',workspace_api_verified_files:1,remote_archive_verified_at:'2026-09-15T00:00:00.000Z',remote_archive_files:6,workspace_capture:{archive_sha256:'a'.repeat(64),entries:4,files:1},workspace_restore:{restored_entries:4,regular_files:1,metadata_verified:true,root_directory_verified:true,exact_inventory_verified:true,file_hashes_verified:true,target:'/workspace/project'}};
test('missing references and unapproved skips cannot complete a file migration',()=>{
 for(const workspace_status of ['no-source-sandbox-reference','unresolved-source-sandbox','capture-pending','skipped']) expect(()=>assertWorkspaceVerified('project',{workspace_status})).toThrow('Workspace is unresolved');
});
test('completion requires matching source and restored inventory evidence',()=>{
 expect(()=>assertWorkspaceVerified('project',valid)).not.toThrow();
 for(const patch of [{root_directory_verified:false},{exact_inventory_verified:false},{file_hashes_verified:false},{regular_files:0},{restored_entries:3},{metadata_verified:false},{target:'/workspace/other'}]) expect(()=>assertWorkspaceVerified('project',{...valid,workspace_restore:{...valid.workspace_restore,...patch}})).toThrow('does not match');
});
test('an empty workspace requires a captured and verified directory inventory',()=>{
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_api_verified_files:0,workspace_capture:{...valid.workspace_capture,entries:1,files:0},workspace_restore:{...valid.workspace_restore,restored_entries:1,regular_files:0}})).not.toThrow();
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_capture:undefined})).toThrow('Workspace is unresolved');
 expect(()=>assertWorkspaceVerified('project',{...valid,remote_archive_verified_at:undefined})).toThrow('Workspace is unresolved');
 expect(()=>assertWorkspaceVerified('project',{...valid,remote_archive_files:5})).toThrow('Workspace is unresolved');
});

test('a file count cannot consume the required root directory',()=>{
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_api_verified_files:1,workspace_capture:{...valid.workspace_capture,entries:1},workspace_restore:{...valid.workspace_restore,restored_entries:1}})).toThrow();
});

test('destination file API must read back every captured regular file',()=>{
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_api_verified_files:0})).toThrow('does not match');
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_api_verified_files:undefined})).toThrow('does not match');
});

test('approved missing sandbox verifies history without claiming file restoration',()=>{
 const proof={workspace_status:'approved-404-workspace-skip',source_sandbox_id:'box',approved_exception:{source_project_id:'project',source_sandbox_id:'box',provider_http:404,authorized_at:'2026-09-14T00:00:00Z'},remote_archive_files:4,remote_archive_verified_at:'2026-09-15T00:00:00Z',owner_verified:true,marko_access_verified:true,native_messages_verified:true};
 expect(()=>assertApprovedMissingSandboxException(proof)).not.toThrow();
 expect(()=>assertWorkspaceVerified('project',proof)).toThrow();
 expect(()=>assertApprovedMissingSandboxException({...proof,approved_exception:{...proof.approved_exception,provider_http:200}})).toThrow();
 expect(()=>assertApprovedMissingSandboxException({...proof,remote_archive_files:6})).toThrow();
});

test('a scoped missing-reference waiver verifies history without file proof',()=>{
 const proof={workspace_status:'approved-no-reference-workspace-skip',source_sandbox_id:null,approved_exception:{source_project_id:'project',reason:'missing-sandbox-reference',authorized_at:'2026-09-15T00:00:00Z',source_mapping_problems:['missing-sandbox-reference']},remote_archive_files:4,remote_archive_verified_at:'2026-09-15T00:00:00Z',owner_verified:true,marko_access_verified:true,native_messages_verified:true};
 expect(()=>assertApprovedNoReferenceWorkspaceException('project',proof)).not.toThrow();
 expect(()=>assertApprovedNoReferenceWorkspaceException('other',proof)).toThrow();
 expect(()=>assertApprovedNoReferenceWorkspaceException('project',{...proof,source_sandbox_id:'box'})).toThrow();
 expect(()=>assertApprovedNoReferenceWorkspaceException('project',{...proof,approved_exception:{...proof.approved_exception,source_mapping_problems:[]}})).toThrow();
 expect(()=>assertApprovedNoReferenceWorkspaceException('project',{...proof,remote_archive_files:6})).toThrow();
});


test('unrecoverable workspace waiver is scoped and never claims restored files',()=>{
 const proof={workspace_status:'approved-unrecoverable-workspace-skip',source_sandbox_id:'box',files_status:'unavailable',approved_exception:{source_ref:'source',source_project_id:'project',source_sandbox_id:'box',reason:'unrecoverable-missing-volume',authorized_at:'2026-09-15T00:00:00Z',provider_state:'error',recoverable:false},remote_archive_files:4,remote_archive_verified_at:'2026-09-15T00:00:00Z',owner_verified:true,marko_access_verified:true,native_messages_verified:true};
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',proof)).not.toThrow();
 expect(()=>assertWorkspaceVerified('project',proof)).toThrow();
 expect(()=>assertApprovedUnrecoverableWorkspaceException('other','project',proof)).toThrow();
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','other',proof)).toThrow();
 for(const patch of [{source_sandbox_id:'other'},{files_status:'restored'},{workspace_capture:{}},{workspace_restore:{}},{remote_archive_files:6},{owner_verified:false},{marko_access_verified:false},{native_messages_verified:false}])expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',{...proof,...patch})).toThrow();
 for(const patch of [{recoverable:true},{provider_state:'archived'},{authorized_at:''},{reason:'missing-sandbox-reference'}])expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',{...proof,approved_exception:{...proof.approved_exception,...patch}})).toThrow();
});

test('provider-error and stuck-archiving waivers require matching provider evidence',()=>{
 const base={workspace_status:'approved-unrecoverable-workspace-skip',source_sandbox_id:'box',files_status:'unavailable',remote_archive_files:4,remote_archive_verified_at:'2026-09-15T00:00:00Z',owner_verified:true,marko_access_verified:true,native_messages_verified:true};
 const approved={source_ref:'source',source_project_id:'project',source_sandbox_id:'box',authorized_at:'2026-09-16T00:00:00Z',provider_checked_at:'2026-09-16T00:00:00Z',recoverable:false};
 const providerError={...base,approved_exception:{...approved,reason:'unrecoverable-provider-error',provider_state:'error'}};
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',providerError)).not.toThrow();
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',{...providerError,approved_exception:{...providerError.approved_exception,recoverable:true}})).toThrow();
 const oldUpdatedAt=new Date(Date.now()-3*24*60*60*1000).toISOString();
 const archiving={...base,approved_exception:{...approved,reason:'stuck-archiving',provider_state:'archiving',provider_updated_at:oldUpdatedAt}};
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',archiving)).not.toThrow();
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',{...archiving,approved_exception:{...archiving.approved_exception,provider_updated_at:new Date().toISOString()}})).toThrow();
 expect(()=>assertApprovedUnrecoverableWorkspaceException('source','project',{...archiving,approved_exception:{...archiving.approved_exception,provider_checked_at:''}})).toThrow();
});
