#!/usr/bin/env bash

# make a wallet.json file from secrets-manager
aws secretsmanager get-secret-value --secret-id ao-wallet --query SecretString --output text > wallet.json

# make a .env file
echo "SU_WALLET_PATH=wallet.json" >> .env

exec ./su $1
