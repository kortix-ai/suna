{{- define "qa-portal.name" -}}
qa-portal
{{- end -}}

{{- define "qa-portal.labels" -}}
app.kubernetes.io/name: {{ include "qa-portal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix
{{- end -}}

{{- define "qa-portal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qa-portal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
