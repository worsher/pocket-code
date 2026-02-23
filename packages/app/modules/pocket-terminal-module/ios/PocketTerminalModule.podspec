Pod::Spec.new do |s|
  s.name           = 'PocketTerminalModule'
  s.version        = '1.0.0'
  s.summary        = 'A sample project summary'
  s.description    = 'A sample project description'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/android/src/main/cpp/include" "${PODS_TARGET_SRCROOT}/android/src/main/cpp/src" "${PODS_TARGET_SRCROOT}/cpp"'
  }

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}", "cpp/**/*.{h,cpp}", "android/src/main/cpp/src/**/*.{c,h}", "android/src/main/cpp/*.{cpp,h}"
end
