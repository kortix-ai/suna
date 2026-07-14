{{/*
Shared pod template (metadata + spec) used by BOTH the Deployment and the Argo
Rollouts Rollout, so the two can never drift. Include under `template:` with:
  {{- include "kortix-api.podTemplate" . | nindent 4 }}
*/}}
{{- define "kortix-api.podTemplate" -}}
metadata:
  labels:
    {{- include "kortix-api.selectorLabels" . | nindent 4 }}
  annotations:
    # Roll pods whenever the synced secret changes so config updates take
    # effect without a manual restart.
    checksum/secret-name: {{ .Values.externalSecrets.targetSecretName | sha256sum }}
spec:
  serviceAccountName: {{ .Values.serviceAccount.name }}
  terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
  {{- if .Values.priorityClassName }}
  priorityClassName: {{ .Values.priorityClassName }}
  {{- end }}
  {{- if .Values.security.enabled }}
  securityContext:
    runAsNonRoot: {{ .Values.security.runAsNonRoot }}
    runAsUser: {{ .Values.security.runAsUser }}
    runAsGroup: {{ .Values.security.runAsGroup }}
    fsGroup: {{ .Values.security.runAsGroup }}
    seccompProfile:
      type: {{ .Values.security.seccompProfile }}
  {{- end }}
  {{- if .Values.topologySpread.enabled }}
  # Keep replicas spread across AZs first, then nodes — a node or full-AZ loss
  # can never take out all pods. ScheduleAnyway so a temporary skew never blocks
  # scheduling.
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "kortix-api.selectorLabels" . | nindent 10 }}
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "kortix-api.selectorLabels" . | nindent 10 }}
  {{- end }}
  containers:
    - name: api
      image: {{ include "kortix-api.image" . | quote }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      ports:
        - name: http
          containerPort: {{ .Values.containerPort }}
          protocol: TCP
      env:
        - name: PORT
          value: {{ .Values.containerPort | quote }}
        {{- if .Values.kortixVersion }}
        - name: KORTIX_VERSION
          value: {{ .Values.kortixVersion | quote }}
        {{- end }}
        {{- if .Values.env.internalKortixEnv }}
        - name: INTERNAL_KORTIX_ENV
          value: {{ .Values.env.internalKortixEnv | quote }}
        {{- end }}
        {{- if not .Values.workers.enabled }}
        # API-only profile: force the leader-elected singleton workers off so
        # this env never runs scheduler/maintenance/migration jobs.
        - name: KORTIX_TRIGGER_SCHEDULER_ENABLED
          value: "false"
        - name: KORTIX_PROJECT_MAINTENANCE_ENABLED
          value: "false"
        - name: KORTIX_LEGACY_MIGRATION_WORKER_ENABLED
          value: "false"
        - name: KORTIX_SUNA_MIGRATION_WORKER_ENABLED
          value: "false"
        {{- end }}
        {{- range $k, $v := .Values.extraEnv }}
        - name: {{ $k }}
          value: {{ $v | quote }}
        {{- end }}
      # All secrets (the synced bundle) as environment variables.
      {{- if .Values.externalSecrets.targetSecretName }}
      envFrom:
        - secretRef:
            name: {{ .Values.externalSecrets.targetSecretName }}
      {{- end }}
      # Drain before exit: on SIGTERM, sleep so the ALB deregisters this pod
      # (readiness + target-group deregistration) before the process stops.
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep {{ .Values.preStopSleepSeconds }}"]
      # startup: tolerate a slow first boot; liveness: restart a hung pod;
      # readiness: pull a not-ready pod out of the ALB until it recovers.
      startupProbe:
        httpGet:
          path: {{ .Values.health.path }}
          port: http
        periodSeconds: 5
        failureThreshold: {{ .Values.health.startupFailureThreshold }}
      livenessProbe:
        httpGet:
          # Defaults to the shallow path; set health.livenessPath to /health/live
          # (event-loop-lag aware) once a route-bearing image is live in the env.
          path: {{ .Values.health.livenessPath | default .Values.health.path }}
          port: http
        periodSeconds: {{ .Values.health.livenessPeriodSeconds }}
        timeoutSeconds: 5
        failureThreshold: 3
      readinessProbe:
        httpGet:
          path: {{ .Values.health.path }}
          port: http
        periodSeconds: {{ .Values.health.readinessPeriodSeconds }}
        timeoutSeconds: 5
        failureThreshold: 3
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
      {{- if .Values.security.enabled }}
      securityContext:
        allowPrivilegeEscalation: {{ .Values.security.allowPrivilegeEscalation }}
        readOnlyRootFilesystem: {{ .Values.security.readOnlyRootFilesystem }}
        {{- if .Values.security.dropAllCapabilities }}
        capabilities:
          drop: ["ALL"]
        {{- end }}
      {{- end }}
      {{- if and .Values.security.enabled .Values.security.readOnlyRootFilesystem }}
      volumeMounts:
        {{- range $i, $p := .Values.security.writableMounts }}
        - name: writable-{{ $i }}
          mountPath: {{ $p }}
        {{- end }}
      {{- end }}
  {{- if and .Values.security.enabled .Values.security.readOnlyRootFilesystem }}
  volumes:
    {{- range $i, $p := .Values.security.writableMounts }}
    - name: writable-{{ $i }}
      emptyDir: {}
    {{- end }}
  {{- end }}
{{- end -}}
