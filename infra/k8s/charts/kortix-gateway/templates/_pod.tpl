{{/*
Shared pod template (metadata + spec) for the gateway Deployment (and the
Rollout, if ever enabled), so the two can never drift. Include under `template:`:
  {{- include "kortix-gateway.podTemplate" . | nindent 4 }}
*/}}
{{- define "kortix-gateway.podTemplate" -}}
metadata:
  labels:
    {{- include "kortix-gateway.selectorLabels" . | nindent 4 }}
  annotations:
    # Roll pods whenever the consumed secret changes so config updates take
    # effect without a manual restart.
    checksum/secret-name: {{ .Values.envFromSecret | sha256sum }}
spec:
  serviceAccountName: {{ .Values.serviceAccount.name }}
  terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
  {{- if .Values.topologySpread.enabled }}
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "kortix-gateway.selectorLabels" . | nindent 10 }}
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "kortix-gateway.selectorLabels" . | nindent 10 }}
  {{- end }}
  containers:
    - name: gateway
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      ports:
        - name: http
          containerPort: {{ .Values.containerPort }}
          protocol: TCP
      env:
        - name: PORT
          value: {{ .Values.containerPort | quote }}
        {{- range $k, $v := .Values.extraEnv }}
        - name: {{ $k }}
          value: {{ $v | quote }}
        {{- end }}
      # The API's already-synced secret bundle (GATEWAY_INTERNAL_TOKEN, LANGFUSE_*).
      envFrom:
        - secretRef:
            name: {{ .Values.envFromSecret }}
      # Drain before exit: on SIGTERM, sleep so the ALB deregisters this pod
      # before the process stops — combined with the long grace period, in-flight
      # LLM streams finish instead of being cut.
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep {{ .Values.preStopSleepSeconds }}"]
      startupProbe:
        httpGet:
          path: {{ .Values.health.path }}
          port: http
        periodSeconds: 5
        failureThreshold: {{ .Values.health.startupFailureThreshold }}
      livenessProbe:
        httpGet:
          path: {{ .Values.health.path }}
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
{{- end -}}
