#!/usr/bin/env bash
# Makes a trimmed Java runtime under apps/morphy-desktop/jre with jlink, for electron-builder
# to bundle. Needs a JDK 21+ with jmods (on Ubuntu: openjdk-21-jdk).
set -euo pipefail
cd "$(dirname "$0")/.."
JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
if [ ! -d "$JAVA_HOME/jmods" ]; then
  echo "No jmods under $JAVA_HOME — install a full JDK (openjdk-21-jdk)" >&2
  exit 1
fi
JAR=$(ls ../../morphy-service/target/morphy-service-*.jar | grep -v original | head -1)
# The modules the fat jar needs, from jdeps on its classes; java.base and the usual suspects as a floor
MODULES=$("$JAVA_HOME/bin/jdeps" --multi-release 21 --ignore-missing-deps --print-module-deps -q "$JAR" 2>/dev/null || true)
MODULES="${MODULES:-java.base},java.sql,java.naming,java.management,java.instrument,java.desktop,java.net.http,java.security.jgss,java.xml,jdk.unsupported,jdk.crypto.ec,java.logging,java.scripting"
rm -rf jre
"$JAVA_HOME/bin/jlink" --add-modules "$MODULES" --strip-debug --no-man-pages --no-header-files --compress zip-6 --output jre
du -sh jre
