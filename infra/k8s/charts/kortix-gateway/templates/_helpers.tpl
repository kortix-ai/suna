{{- define "kortix-gateway.name" -}}
kortix-gateway
{{- end -}}

{{- define "kortix-gateway.labels" -}}
app.kubernetes.io/name: {{ include "kortix-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix
{{- end -}}

{{- define "kortix-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kortix-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
