import {test,expect} from 'bun:test';
import {assertWorkspaceVerified} from './verification';
const valid = {workspace_status:'captured',source_sandbox_id:'source-box',workspace_capture:{archive_sha256:'a'.repeat(64),entries:4,files:1},workspace_restore:{restored_entries:4,regular_files:1,metadata_verified:true,target:'/workspace/project'}};
test('missing references and unapproved skips cannot complete a file migration',()=>{
 for(const workspace_status of ['no-source-sandbox-reference','unresolved-source-sandbox','capture-pending','skipped']) expect(()=>assertWorkspaceVerified('project',{workspace_status})).toThrow('Workspace is unresolved');
});
test('completion requires matching source and restored inventory evidence',()=>{
 expect(()=>assertWorkspaceVerified('project',valid)).not.toThrow();
 for(const patch of [{regular_files:0},{restored_entries:3},{metadata_verified:false},{target:'/workspace/other'}]) expect(()=>assertWorkspaceVerified('project',{...valid,workspace_restore:{...valid.workspace_restore,...patch}})).toThrow('does not match');
});
test('an empty workspace requires a captured and verified directory inventory',()=>{
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_capture:{...valid.workspace_capture,entries:1,files:0},workspace_restore:{...valid.workspace_restore,restored_entries:1,regular_files:0}})).not.toThrow();
 expect(()=>assertWorkspaceVerified('project',{...valid,workspace_capture:undefined})).toThrow('Workspace is unresolved');
});
