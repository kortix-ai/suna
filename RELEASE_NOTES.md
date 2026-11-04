Voice calls, an instant project page, and egress without NAT

### New
- Voice calls: call a session's agent from the session or the agent page, with screen share; the chat keeps what was said (flag `voice_call`). (#11633, #11665)
- Speech-to-text and text-to-speech through the LLM gateway. (#11632)
- Discord sits on the Channels tab like every channel, marks the message the agent works on, and sets up its app with one command. (#11592, #11605)
- Drive: My files by default; shared Drives sit behind the `shared_drives` flag. (#11606)
- Self-hosting: new sessions start from a project snapshot in the bundled object storage. (#11626)
- The mobile app ships a new version to both stores on each production release. (#11646)

### Improved
- The project page renders at once from a saved config summary instead of reading git. (#11651, #11655)
- Faster session starts and first replies: the daemon boots from bytecode, sessions share proofs across API servers, and boot waits are shorter. (#11574, #11611, #11661)
- The API reaches the internet without NAT processing; GitHub traffic keeps the published egress IPs. (#11584)
- Sender avatars show from the first message, and messages from other agents show in full. (#11604, #11617, #11621)
- Windows Capture records GPU-rendered content such as CAD canvases. (#11647)
- The Guide and Developers docs match the product. (#11627, #11629)

### Fixed
- A `kortix.yaml` that is not valid YAML never takes a project down: the project keeps its last valid version, and pushes of a broken file are refused. (#11641)
- Self-hosting: TLS wildcard setup accepts only a strictly valid acme-dns account. (#11659)
- A session's stored sandbox URL follows the domain the request came in on. (#11616)
- Old sessions no longer jump into Today after a branch sweep. (#11600)
- Drive members open Drive without a "You cannot open this folder" toast, and the Drive tree shows its files. (#11591, #11635)
- The npm packages publish again from the renamed repository. (#11654)
- Renaming a workspace in Settings saves once, even when a read lags the write. (#11670)
- Agent file previews (web and mobile) and voice call transcripts stay fast on long or repetitive text; a crafted reply could freeze them for seconds. (#11694, #11697)
