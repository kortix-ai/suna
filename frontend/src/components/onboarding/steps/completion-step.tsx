'use client';

import { motion } from 'framer-motion';
import { CheckCircle2, Sparkles, Users, Zap, ArrowRight, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StepWrapper } from '../shared/step-wrapper';
import { allAgents } from '../shared/data';
import { userContext } from '../shared/context';

export const CompletionStep = () => {
  // Get the configured agents from global context
  const selectedAgentIds = userContext.selectedAgents || [];
  
  const completedAgents = allAgents.filter(agent => 
    selectedAgentIds.includes(agent.id)
  );

  const teamSize = (userContext.invitedTeammates?.length || 0) + 1; // +1 for the user
  const userTypeLabel = userContext.userType === 'individual' ? 'individual' : 'team';

  return (
    <StepWrapper>
      <div className="text-center space-y-8 max-w-3xl mx-auto">
        {/* Success animation */}
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ 
            type: "spring",
            stiffness: 260,
            damping: 20,
            delay: 0.2 
          }}
          className="relative"
        >
          <div className="w-24 h-24 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="h-12 w-12 text-green-600 dark:text-green-400" />
          </div>
          
          {/* Floating sparkles */}
          {[...Array(6)].map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ 
                opacity: [0, 1, 0],
                scale: [0, 1, 0],
                y: [0, -20, -40]
              }}
              transition={{
                duration: 2,
                delay: 0.5 + i * 0.2,
                repeat: Infinity,
                repeatDelay: 3
              }}
              className="absolute"
              style={{
                left: `${20 + i * 12}%`,
                top: `${20 + (i % 2) * 20}%`
              }}
            >
              <Sparkles className="h-4 w-4 text-primary" />
            </motion.div>
          ))}
        </motion.div>

        {/* Main message */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          <h1 className="text-3xl font-bold mb-4">
            🎉 Your AI Workforce is Ready!
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Congratulations! You've successfully set up your AI workforce. 
            Your agents are configured and ready to help you achieve your goals.
          </p>
        </motion.div>

        {/* Summary cards */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="grid md:grid-cols-3 gap-6"
        >
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <CardContent className="p-6 text-center">
              <Users className="h-8 w-8 text-primary mx-auto mb-3" />
              <h3 className="font-semibold text-lg mb-2">{completedAgents.length} AI Agents</h3>
              <p className="text-sm text-muted-foreground">
                Ready to work for your {userTypeLabel}
              </p>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-green-100/50 to-green-50/50 dark:from-green-900/20 dark:to-green-950/10 border-green-200 dark:border-green-800">
            <CardContent className="p-6 text-center">
              <Zap className="h-8 w-8 text-green-600 mx-auto mb-3" />
              <h3 className="font-semibold text-lg mb-2">Fully Configured</h3>
              <p className="text-sm text-muted-foreground">
                Personalized for your specific needs
              </p>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-blue-100/50 to-blue-50/50 dark:from-blue-900/20 dark:to-blue-950/10 border-blue-200 dark:border-blue-800">
            <CardContent className="p-6 text-center">
              <Star className="h-8 w-8 text-blue-600 mx-auto mb-3" />
              <h3 className="font-semibold text-lg mb-2">{teamSize} Team Member{teamSize !== 1 ? 's' : ''}</h3>
              <p className="text-sm text-muted-foreground">
                {teamSize === 1 ? 'Ready to scale' : 'Ready to collaborate'}
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Agent showcase */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="space-y-4"
        >
          <h3 className="text-xl font-semibold flex items-center justify-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Your AI Team
          </h3>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {completedAgents.map((agent, index) => (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ 
                  duration: 0.4, 
                  delay: 0.6 + index * 0.1,
                  type: "spring",
                  stiffness: 300
                }}
              >
                <Card className="hover:shadow-lg transition-shadow">
                  <CardContent className="p-4 text-center">
                    <div className="text-3xl mb-2">{agent.icon}</div>
                    <h4 className="font-semibold text-sm mb-1">{agent.name}</h4>
                    <p className="text-xs text-muted-foreground mb-2">{agent.role}</p>
                    <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Ready
                    </Badge>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Next steps */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.7 }}
          className="bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 border border-primary/20 rounded-xl p-6"
        >
          <h3 className="font-semibold text-lg mb-4">What's Next?</h3>
          <div className="grid md:grid-cols-2 gap-4 text-left">
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <ArrowRight className="h-4 w-4 text-primary" />
                Start Using Your Agents
              </h4>
              <p className="text-sm text-muted-foreground">
                Go to your dashboard and begin assigning tasks to your AI workforce
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <ArrowRight className="h-4 w-4 text-primary" />
                Invite More Team Members
              </h4>
              <p className="text-sm text-muted-foreground">
                Add colleagues to collaborate and share the workload
              </p>
            </div>
          </div>
        </motion.div>

        {/* Call to action */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="pt-4"
        >
          <Button size="lg" className="px-8 py-3 text-lg">
            <Zap className="h-5 w-5 mr-2" />
            Start Working with Your AI Team
            <ArrowRight className="h-5 w-5 ml-2" />
          </Button>
          
          <p className="text-sm text-muted-foreground mt-4">
            You can always modify agent settings and add new team members from your dashboard
          </p>
        </motion.div>
      </div>
    </StepWrapper>
  );
};

