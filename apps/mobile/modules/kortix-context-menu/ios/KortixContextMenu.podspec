Pod::Spec.new do |s|
  s.name           = 'KortixContextMenu'
  s.version        = '1.0.0'
  s.summary        = 'The iOS system context menu around React Native content'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Kortix'
  s.homepage       = 'https://kortix.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
