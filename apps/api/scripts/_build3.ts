import { ensureSandboxImage, DEFAULT_SANDBOX_SLUG } from '../src/snapshots/builder';
const shell:any={projectId:'',repoUrl:'',defaultBranch:'',manifestPath:''};
try{const r=await ensureSandboxImage(shell,{slug:DEFAULT_SANDBOX_SLUG,source:'manual',provider:'platinum'});console.log('DONE',JSON.stringify(r));}catch(e:any){console.log('BUILDERR',e?.message);}
process.exit(0);
