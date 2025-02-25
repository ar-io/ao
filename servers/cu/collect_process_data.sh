#!/bin/bash

set -e

processes=("8Y3BJ6YHtp0uiaM0KSyCdTqLYVJvGLZZI5QjPPskL7I" "GaQrvEMKBpkjofgnBi_B3IgIDmY_XYelVLB6GcRGrHc" "agYcCFJtrMG6cqMuZfskIkFTGvUPddICmtQSBIoPdiA" "MPiGe7qv0wNe92aSq2Mamef1neZMz4AhgKMjCigF5Kw" "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE" "My21NOHZyyeQG0t0yANsWjRakNDM7CJvd8urtdMLEDE")

for process in "${processes[@]}"; do
  status_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:6363/state/$process")
  if [[ "$status_code" != "200" ]]; then
    echo "[ERROR] Process $process failed with status $status_code"
    exit 1
  fi
done

echo "All processes are healthy."
exit 0
