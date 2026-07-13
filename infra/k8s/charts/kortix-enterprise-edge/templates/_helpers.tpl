{{- define "kortix-enterprise-edge.labels" -}}
app.kubernetes.io/name: kortix-frontend
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix-enterprise
{{- end -}}

{{- define "kortix-enterprise-edge.selectorLabels" -}}
app.kubernetes.io/name: kortix-frontend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kortix-enterprise-edge.image" -}}
{{- if .Values.image.digest -}}
{{ printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end -}}
{{- end -}}
