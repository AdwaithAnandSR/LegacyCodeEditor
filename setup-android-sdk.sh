#!/bin/bash
set -e

echo "Starting Android SDK and NDK setup..."

echo "Step 1: Installing Java 17 and dependencies..."
sudo apt update
sudo apt install openjdk-17-jdk wget unzip -y

echo "Step 2: Creating SDK directories..."
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools

echo "Step 3: Downloading and extracting Command Line Tools..."
cd $ANDROID_HOME/cmdline-tools
if [ ! -d "latest" ]; then
    wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdtools.zip
    unzip cmdtools.zip
    rm cmdtools.zip
    mv cmdline-tools latest
else
    echo "Command line tools already exist. Skipping download."
fi

echo "Step 4: Setting up environment variables..."
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

if ! grep -q "ANDROID_HOME" ~/.bashrc; then
    echo "export ANDROID_HOME=$ANDROID_HOME" >> ~/.bashrc
    echo 'export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools' >> ~/.bashrc
fi

echo "Step 5: Accepting licenses..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true

echo "Step 6: Installing platform tools, SDK 35, and Build Tools..."
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

echo "Step 7: Installing NDK and CMake for C++ compilation..."
sdkmanager "ndk;27.1.12297006" "cmake;3.22.1"

echo "Step 8: Configuring local.properties for the project..."
# Return to the directory where the script was executed (repo root)
cd - > /dev/null
if [ -d "android" ]; then
    echo "sdk.dir=$ANDROID_HOME" > android/local.properties
    echo "Successfully generated android/local.properties"
else
    echo "Warning: 'android' directory not found. Ensure this script is run from the project root."
fi

echo "----------------------------------------"
echo "Setup complete! Run the following command to update your current terminal session:"
echo "source ~/.bashrc"
