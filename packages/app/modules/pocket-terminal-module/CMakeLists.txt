cmake_minimum_required(VERSION 3.22.1)
project(pocket_terminal_module)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find remaining prefab libraries exposed by React Native core packages
find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

# 导入用户拆分出来的 libpocket-core 子模块 (位于 packages/libpocket-core)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../../libpocket-core libpocket-core)

include_directories(
        ${CMAKE_CURRENT_SOURCE_DIR}/cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../../../libpocket-core/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../../../libpocket-core/third_party/libvterm/include
)

file(GLOB JSI_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/cpp/*.cpp")

add_library(
        pocket_terminal_module
        SHARED
        ${JSI_SOURCES}
)

target_link_libraries(
        pocket_terminal_module
        log
        ReactAndroid::jsi
        fbjni::fbjni
        pocket-core
)
