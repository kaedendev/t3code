require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3ParakeetNative'
  s.version = package['version']
  s.summary = 'On-device Parakeet speech recognition for T3 Code mobile.'
  s.description = 'Runs NVIDIA Parakeet TDT 0.6B v3 on the Neural Engine through FluidAudio.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.static_framework = true
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  # CocoaPods trunk stops at FluidAudio 0.7.8; later releases ship only as a Swift package.
  spm_dependency(s,
    url: 'https://github.com/FluidInference/FluidAudio.git',
    requirement: { kind: 'exactVersion', version: '0.18.2' },
    products: ['FluidAudio']
  )
end
