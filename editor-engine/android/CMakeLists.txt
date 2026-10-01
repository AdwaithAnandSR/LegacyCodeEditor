project(NitroEditorEngine)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME NitroEditorEngine)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# Define C++ library and add all sources
add_library(${PACKAGE_NAME} SHARED
        src/main/cpp/cpp-adapter.cpp
        ../cpp/HybridEditorEngine.cpp
        ../cpp/SyntaxEngine.cpp
        ../cpp/tree-sitter/src/lib.c
        ../cpp/parsers/javascript/parser.c
        ../cpp/parsers/javascript/scanner.c
)

# Add Nitrogen specs :)
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroEditorEngine+autolinking.cmake)

# Set up local includes
include_directories(
        "src/main/cpp"
        "../cpp"
        "../cpp/tree-sitter/include"
)

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android                                   # <-- Android core
)
