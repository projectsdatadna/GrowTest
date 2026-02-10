@echo off
REM AWS Deployment Script for Windows

echo === AWS Deployment Script ===
echo.
echo Choose deployment option:
echo 1. App Runner (Easiest)
echo 2. Elastic Beanstalk
echo 3. EC2 (Manual)
echo 4. ECS/Fargate (Docker)
echo.
set /p option="Enter option (1-4): "

if "%option%"=="1" (
    echo === Deploying to App Runner ===
    echo.
    echo Prerequisites:
    echo 1. AWS CLI installed and configured
    echo 2. GitHub repo created
    echo.
    set /p repo_url="Enter GitHub repo URL: "
    set /p region="Enter AWS region (default: us-east-1): "
    if "%region%"=="" set region=us-east-1
    
    echo.
    echo Steps to deploy:
    echo 1. Push code to GitHub:
    echo    git init
    echo    git add .
    echo    git commit -m "Initial commit"
    echo    git remote add origin %repo_url%
    echo    git push -u origin main
    echo.
    echo 2. Go to AWS Console ^> App Runner
    echo 3. Click 'Create service'
    echo 4. Select 'Source code repository'
    echo 5. Connect GitHub and select your repo
    echo 6. Runtime: Node.js 18
    echo 7. Build command: npm run build
    echo 8. Start command: node server.js
    echo 9. Add environment variables:
    echo    - CLAUDE_API_KEY
    echo    - VITE_API_BASE_URL
    echo 10. Deploy
    
) else if "%option%"=="2" (
    echo === Deploying to Elastic Beanstalk ===
    echo.
    set /p app_name="Enter application name (default: instrument-dashboard): "
    if "%app_name%"=="" set app_name=instrument-dashboard
    set /p env_name="Enter environment name (default: production): "
    if "%env_name%"=="" set env_name=production
    set /p region="Enter AWS region (default: us-east-1): "
    if "%region%"=="" set region=us-east-1
    set /p claude_key="Enter CLAUDE_API_KEY: "
    
    echo.
    echo Installing EB CLI...
    pip install awsebcli
    
    echo Initializing Elastic Beanstalk...
    call eb init -p node.js-18 %app_name% --region %region%
    
    echo Creating environment...
    call eb create %env_name%
    
    echo Setting environment variables...
    call eb setenv CLAUDE_API_KEY=%claude_key% NODE_ENV=production
    
    echo Deploying...
    call eb deploy
    
    echo.
    echo Deployment complete!
    
) else if "%option%"=="3" (
    echo === EC2 Deployment (Manual) ===
    echo.
    set /p instance_ip="Enter EC2 instance IP/DNS: "
    set /p key_file="Enter path to .pem key file: "
    set /p ec2_user="Enter EC2 user (default: ubuntu): "
    if "%ec2_user%"=="" set ec2_user=ubuntu
    
    echo.
    echo Uploading files to EC2...
    echo Using SCP to upload files...
    echo Run this command in your terminal:
    echo scp -i "%key_file%" -r . %ec2_user%@%instance_ip%:/home/%ec2_user%/instrument-dashboard
    echo.
    echo Then SSH and run:
    echo ssh -i "%key_file%" %ec2_user%@%instance_ip%
    echo.
    echo cd /home/%ec2_user%/instrument-dashboard
    echo npm install
    echo npm run build
    echo sudo npm install -g pm2
    echo pm2 start server.js --name "instrument-api"
    echo pm2 startup
    echo pm2 save
    
) else if "%option%"=="4" (
    echo === ECS/Fargate Deployment ===
    echo.
    set /p account_id="Enter AWS account ID: "
    set /p region="Enter AWS region (default: us-east-1): "
    if "%region%"=="" set region=us-east-1
    set /p repo_name="Enter repository name (default: instrument-dashboard): "
    if "%repo_name%"=="" set repo_name=instrument-dashboard
    set /p claude_key="Enter CLAUDE_API_KEY: "
    
    echo.
    echo Creating ECR repository...
    aws ecr create-repository --repository-name %repo_name% --region %region%
    
    echo Logging in to ECR...
    for /f %%i in ('aws ecr get-login-password --region %region%') do (
        docker login --username AWS --password %%i %account_id%.dkr.ecr.%region%.amazonaws.com
    )
    
    echo Building Docker image...
    docker build -t %repo_name% .
    
    echo Tagging image...
    docker tag %repo_name%:latest %account_id%.dkr.ecr.%region%.amazonaws.com/%repo_name%:latest
    
    echo Pushing to ECR...
    docker push %account_id%.dkr.ecr.%region%.amazonaws.com/%repo_name%:latest
    
    echo.
    echo Image pushed to ECR!
    echo.
    echo Next steps in AWS Console:
    echo 1. Go to ECS ^> Create Cluster
    echo 2. Create Task Definition with:
    echo    - Image: %account_id%.dkr.ecr.%region%.amazonaws.com/%repo_name%:latest
    echo    - Port: 5000
    echo    - Environment variables:
    echo      - CLAUDE_API_KEY=%claude_key%
    echo      - VITE_API_BASE_URL=^<your-load-balancer-url^>
    echo 3. Create Service in cluster
    
) else (
    echo Invalid option
    exit /b 1
)

pause
