# The image tools/editor-test-docker.sh runs the editor tests in: the pinned
# node image from tools/container-image.sh, plus a virtual display, the
# libraries Electron loads, and one exact VS Code release.
#
# The base comes in as a build argument rather than being written here, so
# that tools/container-image.sh stays the one place its digest is pinned.

ARG BASE
FROM ${BASE}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates curl xauth xvfb \
        libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 \
        libdrm2 libgbm1 libgtk-3-0t64 libnss3 libsecret-1-0 libxcomposite1 \
        libxdamage1 libxkbfile1 libxrandr2 libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Checked against a digest, as the base image is: this binary is what runs
# the tests, so a substituted download would be a substituted test.
ARG VSCODE_URL
ARG VSCODE_SHA256
RUN curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --output /tmp/vscode.tar.gz "${VSCODE_URL}" \
    && echo "${VSCODE_SHA256}  /tmp/vscode.tar.gz" | sha256sum --check - \
    && mkdir /opt/vscode \
    && tar --extract --gzip --file /tmp/vscode.tar.gz --directory /opt/vscode \
        --strip-components=1 \
    && rm /tmp/vscode.tar.gz
