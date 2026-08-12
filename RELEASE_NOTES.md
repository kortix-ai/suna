Consistent release versions and a steadier test gate

## Fixed

- Production deploys now pin the web app's version at runtime, so the frontend and API always report the same version after a release. Previously a stale setting could leave the web app one version behind the API until it was redeployed by hand.

- Quieter error reporting: three noisy, benign frontend error classes no longer flood the production error stream.

## Internal

- The release test gate is more reliable: the staging test lanes run one at a time so they no longer overload the environment, email-delivery checks self-heal their inbox quota and skip cleanly when the provider is unavailable, and the gate has a realistic time budget so the full suite finishes in one run.
