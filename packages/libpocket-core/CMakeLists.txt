cmake_minimum_required(VERSION 3.10)
project(PocketCore VERSION 1.0.0 LANGUAGES C CXX)

# 设置 C++ 标准
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 定义包含目录
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libvterm/include
)

# 获取 third_party/libvterm 源文件
file(GLOB VTERM_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/third_party/libvterm/src/*.c")

# 如果这是在 Android 环境下编译 (JNI)
if(CMAKE_SYSTEM_NAME MATCHES "Android")
    find_library(log-lib log)
    
    # 核心共享库构建，混合编译 C 和 CXX 源码
    add_library(pocket-core SHARED
        src/pocket_terminal.cpp
        src/jni_bridge.cpp
        ${VTERM_SOURCES}
    )
    
    target_link_libraries(pocket-core ${log-lib})
else()
    # iOS / Desktop 测试环境下的静态库或共享库
    add_library(pocket-core STATIC
        src/pocket_terminal.cpp
        ${VTERM_SOURCES}
    )
endif()
