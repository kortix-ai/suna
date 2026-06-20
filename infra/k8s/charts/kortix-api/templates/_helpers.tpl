{{- define "kortix-api.name" -}}
kortix-api
{{- end -}}

{{- define "kortix-api.labels" -}}
app.kubernetes.io/name: {{ include "kortix-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix
{{- end -}}

{{- define "kortix-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kortix-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
