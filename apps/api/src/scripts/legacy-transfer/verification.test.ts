import {test,expect} from 'bun:test';
import {assertWorkspaceVerified} from './verification';
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
